// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { LinkPurpose } from "../../shared/api/access.ts";
import type { Db } from "../db/index.ts";
import { DAY_MS, HOUR_MS } from "../lib/clock.ts";
import { newId } from "../lib/ids.ts";

// the fifth wrong code kills a sign-in link, and ends an invite's code
// while its link still works
export const MAX_CODE_TRIES = 5;

// a link an email carries; its token and code hashes are set when the
// email is sent
export type Link = {
  id: string;
  purpose: LinkPurpose;
  userId: string;
  expiresAt: number;
  usedAt: number | null;
};

type Raw = {
  id: string;
  purpose: LinkPurpose;
  user_id: string;
  expires_at: number;
  used_at: number | null;
};

const row = (raw: Raw): Link => ({
  id: raw.id,
  purpose: raw.purpose,
  userId: raw.user_id,
  expiresAt: raw.expires_at,
  usedAt: raw.used_at,
});

// a used link: its user and purpose
export type Used = { userId: string; purpose: LinkPurpose };

// a live link a code is tried against: asked when a browser asked for
// it, so the fifth miss kills it
type Tried = { id: string; code_hash: string; asked: number };

export class LinkStore {
  constructor(private readonly db: Db) {}

  // expiresAt bounds the wait for the email; the send starts it again.
  // askHash is the asking browser's challenge, null for an invite
  create(fields: {
    purpose: LinkPurpose;
    userId: string;
    issuedBy: string | null;
    askHash: string | null;
    now: number;
    expiresAt: number;
  }): string {
    const id = newId();
    this.db
      .query(
        `insert into user_links (id, purpose, user_id, issued_by, ask_hash,
           created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.purpose,
        fields.userId,
        fields.issuedBy,
        fields.askHash,
        fields.now,
        fields.expiresAt,
      );
    return id;
  }

  // a fresh token's and code's hashes on the unused link, and its expiry
  // from now; false when it was revoked or used since its email was
  // queued
  mint(
    id: string,
    userId: string,
    tokenHash: string,
    codeHash: string,
    expiresAt: number,
  ): boolean {
    return (
      this.db
        .query(
          `update user_links set token_hash = ?, code_hash = ?, expires_at = ?
           where id = ? and user_id = ? and used_at is null`,
        )
        .run(tokenHash, codeHash, expiresAt, id, userId).changes > 0
    );
  }

  byTokenHash(tokenHash: string): Link | null {
    const raw = this.db
      .query<Raw, [string]>(
        `select id, purpose, user_id, expires_at, used_at from user_links
         where token_hash = ?`,
      )
      .get(tokenHash);
    return raw === null ? null : row(raw);
  }

  // the one write that uses a link, by its token or its id: unused,
  // unexpired and its user enabled, or nothing. Using it uses its code
  use(by: "token" | "id", value: string, now: number): Used | null {
    const column = by === "token" ? "token_hash" : "id";
    const raw = this.db
      .query<
        { user_id: string; purpose: LinkPurpose },
        [number, string, number]
      >(
        `update user_links set used_at = ?
         where ${column} = ? and used_at is null and expires_at > ?
           and user_id in (select id from users where disabled = 0)
         returning user_id, purpose`,
      )
      .get(now, value, now);
    return raw === null ? null : { userId: raw.user_id, purpose: raw.purpose };
  }

  // the live, sent links a code may be tried against beside this
  // challenge: those it asked for, and invites, which no browser asked
  // for, while their code has tries left
  tried(userId: string, askHash: string, now: number): Tried[] {
    return this.db
      .query<Tried, [string, number, string, number]>(
        `select id, code_hash, ask_hash is not null as asked from user_links
         where user_id = ?1 and used_at is null and expires_at > ?2
           and code_hash is not null
           and (ask_hash = ?3 or (ask_hash is null and code_tries < ?4))`,
      )
      .all(userId, now, askHash, MAX_CODE_TRIES);
  }

  // a wrong code against the link; the fifth kills an asked one
  miss(id: string, asked: boolean, now: number): void {
    this.db
      .query(
        `update user_links set code_tries = code_tries + 1,
           used_at = case when ?2 and code_tries + 1 >= ?3 then ?4
             else used_at end
         where id = ?1`,
      )
      .run(id, asked ? 1 : 0, MAX_CODE_TRIES, now);
  }

  // whether this challenge already signed the user in: a link of theirs
  // it asked for, used, never one killed by wrong codes
  known(userId: string, askHash: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string, string, number]>(
          `select count(*) as n from user_links
           where user_id = ? and ask_hash = ? and used_at is not null
             and code_tries < ?`,
        )
        .get(userId, askHash, MAX_CODE_TRIES)!.n > 0
    );
  }

  // the asks the caps count, after since: a user's from one challenge,
  // a user's from any, one challenge's for anyone, and the instance's
  countAsks(by: { userId?: string; askHash?: string }, since: number): number {
    if (by.userId !== undefined && by.askHash !== undefined) {
      return this.db
        .query<{ n: number }, [string, string, number]>(
          `select count(*) as n from link_asks
           where user_id = ? and challenge_hash = ? and asked_at > ?`,
        )
        .get(by.userId, by.askHash, since)!.n;
    }
    if (by.userId !== undefined) {
      return this.db
        .query<{ n: number }, [string, number]>(
          `select count(*) as n from link_asks
           where user_id = ? and asked_at > ?`,
        )
        .get(by.userId, since)!.n;
    }
    if (by.askHash !== undefined) {
      return this.db
        .query<{ n: number }, [string, number]>(
          `select count(*) as n from link_asks
           where challenge_hash = ? and asked_at > ?`,
        )
        .get(by.askHash, since)!.n;
    }
    return this.db
      .query<{ n: number }, [number]>(
        "select count(*) as n from link_asks where asked_at > ?",
      )
      .get(since)!.n;
  }

  recordAsk(userId: string, askHash: string, now: number): void {
    this.db
      .query(
        "insert into link_asks (user_id, challenge_hash, asked_at) values (?, ?, ?)",
      )
      .run(userId, askHash, now);
  }

  // the user's unused links, of one purpose or all; the count removed
  revoke(userId: string, purpose?: LinkPurpose): number {
    return purpose === undefined
      ? this.db
          .query("delete from user_links where user_id = ? and used_at is null")
          .run(userId).changes
      : this.db
          .query(
            `delete from user_links where user_id = ? and purpose = ?
             and used_at is null`,
          )
          .run(userId, purpose).changes;
  }

  // used or not, a link past its expiry is of no use; it stays an hour
  // more, past the email's last retry, so that retry mints it again
  // rather than dropping as revoked (use() and tried() check expiry).
  // An ask counts for a day
  sweep(now: number): number {
    const links = this.db
      .query("delete from user_links where expires_at <= ?")
      .run(now - HOUR_MS).changes;
    const asks = this.db
      .query("delete from link_asks where asked_at <= ?")
      .run(now - DAY_MS).changes;
    return links + asks;
  }
}
