// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The links an email carries, each with a six-digit code. Issuing one
// writes an unminted link and queues its email, which names it, in the
// caller's transaction; the kind's prepare mints the token and the code
// when the email is sent, so the outbox never holds either and the
// expiry starts at the send. Every ask makes a new link and leaves the
// earlier live ones working; an invite replaces the unused one.

import { LINK_PURPOSES, type LinkPurpose } from "../../shared/api/access.ts";
import { type Db, transact } from "../db/index.ts";
import {
  ASKS_PER_CHALLENGE_HOUR,
  ASKS_PER_HOUR,
  ASKS_PER_INBOX_DAY,
  ASKS_PER_USER_DAY,
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
};

export type UsersPort = {
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
  // in the caller's transaction: a new invite, replacing the user's
  // unused one and its queued email; the events to return
  invite(userId: string, issuedBy: string): BusEvent[];
  // in the caller's transaction: every unused link and its queued email
  revoke(userId: string): void;
  // in the caller's transaction: the security notice, nothing while
  // email is off
  notice(user: UserRow, event: NoticeEvent, address: string): BusEvent[];
  // a sign-in link and code asked for at the sign-in page by an address,
  // bound to the asking browser's challenge; looked up and issued after
  // the answer, so neither the answer nor its time says whether the
  // account exists
  ask(email: string, challenge: string): void;
  // resolves once every ask so far has run
  settled(): Promise<void>;
  // no ask starts work from here; resolves once every one so far ran
  close(): Promise<void>;
};

// six digits, uniform: a draw past the last whole million is drawn again
export function newCode(): string {
  const top = 4_294_000_000;
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0]!;
    if (n < top) return String(n % 1_000_000).padStart(6, "0");
  }
}

// salted by the link, so one code's hash never matches another link's
export const codeHash = (linkId: string, code: string): string =>
  sha256(`${linkId}:${code}`);

// the cap an ask reached, by its word
type Cap = "user" | "inbox" | "browser" | "instance";

export function links(deps: LinksDeps): Links {
  const pending = new Set<Promise<void>>();
  // set at shutdown: an ask still answers 202 and does nothing
  let closed = false;
  const settled = async () => {
    while (pending.size > 0) await Promise.all([...pending]);
  };

  // markets' caps, counted on asks in the issuing transaction
  const capped = (userId: string, askHash: string, now: number): Cap | null => {
    const asks = (by: { userId?: string; askHash?: string }, ms: number) =>
      deps.store.countAsks(by, now - ms);
    if (asks({ userId, askHash }, DAY_MS) >= ASKS_PER_USER_DAY) return "user";
    // a browser that signed this user in keeps only its own cap, so a
    // stranger's asks never close the inbox to it
    if (
      asks({ userId }, DAY_MS) >= ASKS_PER_INBOX_DAY &&
      !deps.store.known(userId, askHash)
    ) {
      return "inbox";
    }
    if (asks({ askHash }, HOUR_MS) >= ASKS_PER_CHALLENGE_HOUR) return "browser";
    if (asks({}, HOUR_MS) >= ASKS_PER_HOUR) return "instance";
    return null;
  };

  // minted at the send, each try a fresh token and code whose expiry
  // starts now
  const prepare =
    (purpose: LinkPurpose): Prepare =>
    (row, user): EmailContent | DropWord => {
      if (row.linkId === null) return "revoked";
      const token = newToken();
      const code = newCode();
      const minted = deps.store.mint(
        row.linkId,
        user.id,
        sha256(token),
        codeHash(row.linkId, code),
        deps.clock() + LINK_TTL_MS[purpose],
      );
      if (!minted) return "revoked";
      const link = deps.email.link(`/link/${token}`);
      return { ...linkEmail(purpose, link, code), perTry: true };
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

  const asked = (email: string, challenge: string) => {
    if (!deps.email.enabled()) return;
    const user = deps.users.byEmail(email);
    if (user === null || user.disabled || user.emailPlaceholder) return;
    const askHash = sha256(challenge);
    const outcome = transact<Cap | "issued">(deps.db, () => {
      const now = deps.clock();
      const cap = capped(user.id, askHash, now);
      if (cap !== null) return { result: cap };
      deps.store.recordAsk(user.id, askHash, now);
      const linkId = deps.store.create({
        purpose: "signin",
        userId: user.id,
        issuedBy: user.id,
        askHash,
        now,
        expiresAt: now + LINK_TTL_MS.signin,
      });
      return {
        result: "issued",
        events: deps.email.enqueue({ kind: "signin", userId: user.id, linkId }),
      };
    });
    if (outcome === "issued") {
      deps.log.info("link issued", { user: user.username, purpose: "signin" });
    } else {
      deps.log.warn("link ask capped", { cap: outcome, user: user.username });
    }
  };

  return {
    invite(userId, issuedBy) {
      const now = deps.clock();
      deps.store.revoke(userId, "invite");
      deps.email.dropQueued(userId, ["invite"]);
      const linkId = deps.store.create({
        purpose: "invite",
        userId,
        issuedBy,
        askHash: null,
        now,
        expiresAt: now + LINK_TTL_MS.invite,
      });
      return deps.email.enqueue({ kind: "invite", userId, linkId });
    },
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
    ask(email, challenge) {
      // past the shutdown's last wait the db may be closed
      if (closed) return;
      // a macrotask, so the answer is written before the lookup starts
      const work = new Promise<void>((resolve) => {
        setTimeout(() => {
          try {
            asked(email, challenge);
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
