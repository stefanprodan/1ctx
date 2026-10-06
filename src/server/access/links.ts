// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The links an email carries. Issuing one writes an unminted link and
// queues its email in the caller's transaction; the kind's prepare
// mints the token when the email is sent, so the outbox never holds a
// token and the expiry starts at the send. One unused link per user and
// purpose: a new one replaces the old and its queued email.

import { LINK_PURPOSES, type LinkPurpose } from "../../shared/api/access.ts";
import { type Db, transact } from "../db/index.ts";
import {
  ASKED_LINKS_PER_HOUR,
  ASKED_LINKS_PER_USER_DAY,
  type DropWord,
  type EmailContent,
  type EmailKind,
  type Enqueue,
  type Prepare,
} from "../email/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { type Clock, DAY_MS, HOUR_MS } from "../lib/clock.ts";
import { newToken, sha256 } from "../lib/ids.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { UserRow } from "../users/index.ts";
import {
  htmlOf,
  LINK_TTL_MS,
  linkEmail,
  type NoticeEvent,
  noticeEmail,
} from "./emails.ts";
import type { LinkStore } from "./link-store.ts";

export type EmailPort = {
  enabled(): boolean;
  link(path: string): string;
  enqueue(fields: Enqueue): BusEvent[];
  register(kind: EmailKind, prepare: Prepare): void;
  dropQueued(userId: string, kinds: readonly EmailKind[]): number;
  countAsked(userId: string | null, since: number): number;
};

export type UsersPort = {
  byUsername(username: string): UserRow | null;
  byEmail(email: string): UserRow | null;
};

export type LinksDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  store: LinkStore;
  users: UsersPort;
  email: EmailPort;
};

export type Links = {
  // in the caller's transaction: replaces the user's unused link of the
  // purpose and its queued email; the events to return
  issue(purpose: LinkPurpose, userId: string, issuedBy: string): BusEvent[];
  // in the caller's transaction: every unused link and its queued email
  revoke(userId: string): void;
  // in the caller's transaction: the security notice, nothing while
  // email is off
  notice(user: UserRow, event: NoticeEvent, address: string): BusEvent[];
  // a reset or sign in link asked for at the sign-in page, looked up
  // and issued after the answer, so neither the answer nor its time
  // says whether the account exists
  ask(purpose: "reset" | "signin", name: string): void;
  // resolves once every ask so far has run
  settled(): Promise<void>;
  // no ask starts work from here; resolves once every one so far ran
  close(): Promise<void>;
};

// a username, or an email when it holds an @: the sign-in field's rule
export function byLoginName(users: UsersPort, name: string): UserRow | null {
  return name.includes("@") ? users.byEmail(name) : users.byUsername(name);
}

export function links(deps: LinksDeps): Links {
  const pending = new Set<Promise<void>>();
  // set at shutdown: an ask still answers 202 and does nothing
  let closed = false;
  const settled = async () => {
    while (pending.size > 0) await Promise.all([...pending]);
  };

  const issue = (
    purpose: LinkPurpose,
    userId: string,
    issuedBy: string,
    asked = false,
  ) => {
    const now = deps.clock();
    deps.store.revoke(userId, purpose);
    deps.email.dropQueued(userId, [purpose]);
    deps.store.create({
      purpose,
      userId,
      issuedBy,
      now,
      expiresAt: now + LINK_TTL_MS[purpose],
    });
    return deps.email.enqueue({ kind: purpose, userId, asked });
  };

  // the caps on asks, counted on the outbox in the issuing transaction;
  // the word for the one reached
  const capped = (userId: string): "user" | "instance" | null => {
    const now = deps.clock();
    if (deps.email.countAsked(null, now - HOUR_MS) >= ASKED_LINKS_PER_HOUR) {
      return "instance";
    }
    if (
      deps.email.countAsked(userId, now - DAY_MS) >= ASKED_LINKS_PER_USER_DAY
    ) {
      return "user";
    }
    return null;
  };

  // minted at the send, each try a fresh token whose expiry starts now
  const prepare =
    (purpose: LinkPurpose): Prepare =>
    (_row, user): EmailContent | DropWord => {
      const token = newToken();
      const minted = deps.store.mint(
        user.id,
        purpose,
        sha256(token),
        deps.clock() + LINK_TTL_MS[purpose],
      );
      if (!minted) return "revoked";
      const link = deps.email.link(`/link/${token}`);
      return { ...linkEmail(purpose, user, link), perTry: true };
    };
  for (const purpose of LINK_PURPOSES) {
    deps.email.register(purpose, prepare(purpose));
  }
  // a notice's text is written with its row; the HTML follows it
  deps.email.register("notice", (row) => {
    if (row.subject === null || row.body === null) {
      throw new Error("a notice row has no text");
    }
    return { subject: row.subject, text: row.body, html: htmlOf(row.body) };
  });

  const asked = (wanted: "reset" | "signin", name: string) => {
    if (!deps.email.enabled()) return;
    const user = byLoginName(deps.users, name);
    if (user === null || user.disabled || user.emailPlaceholder) return;
    // signed in by link, a must-change user would be asked for a current
    // password they never knew; a reset sets one instead
    const purpose =
      wanted === "signin" && user.mustChangePassword ? "reset" : wanted;
    const outcome = transact<"live" | "user" | "instance" | "issued">(
      deps.db,
      () => {
        // one live link per user and purpose: a second ask waits it out
        if (deps.store.live(user.id, purpose, deps.clock())) {
          return { result: "live" };
        }
        const cap = capped(user.id);
        if (cap !== null) return { result: cap };
        return {
          result: "issued",
          events: issue(purpose, user.id, user.id, true),
        };
      },
    );
    if (outcome === "instance") {
      deps.log.warn("link ask capped", { cap: outcome });
    } else if (outcome === "user") {
      deps.log.warn("link ask capped", { cap: outcome, user: user.username });
    } else if (outcome === "issued") {
      deps.log.info("link issued", { user: user.username, purpose });
    }
  };

  return {
    issue,
    revoke(userId) {
      deps.store.revoke(userId);
      deps.email.dropQueued(userId, LINK_PURPOSES);
    },
    notice(user, event, address) {
      if (!deps.email.enabled() || user.emailPlaceholder) return [];
      const { subject, text } = noticeEmail(event, user, deps.clock(), address);
      return deps.email.enqueue({
        kind: "notice",
        userId: user.id,
        subject,
        body: text,
      });
    },
    ask(purpose, name) {
      // past the shutdown's last wait the db may be closed
      if (closed) return;
      // a macrotask, so the answer is written before the lookup starts
      const work = new Promise<void>((resolve) => {
        setTimeout(() => {
          try {
            asked(purpose, name);
          } catch (err) {
            deps.log.error("link ask failed", errorFields(err));
          }
          resolve();
        }, 0);
      });
      pending.add(work);
      void work.then(() => pending.delete(work));
    },
    settled,
    close() {
      closed = true;
      return settled();
    },
  };
}
