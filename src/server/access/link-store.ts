// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { LinkPurpose } from "../../shared/api/access.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

// a link an email carries; its token hash is set when the email is sent
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

export class LinkStore {
  constructor(private readonly db: Db) {}

  // expiresAt bounds the wait for the email; the send starts it again
  create(fields: {
    purpose: LinkPurpose;
    userId: string;
    issuedBy: string | null;
    now: number;
    expiresAt: number;
  }): void {
    this.db
      .query(
        `insert into user_links (id, purpose, user_id, issued_by, created_at,
           expires_at) values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        fields.purpose,
        fields.userId,
        fields.issuedBy,
        fields.now,
        fields.expiresAt,
      );
  }

  // an unused link of the purpose that has not expired, sent or not
  live(userId: string, purpose: LinkPurpose, now: number): boolean {
    return (
      this.db
        .query<{ n: number }, [string, string, number]>(
          `select count(*) as n from user_links where user_id = ?
           and purpose = ? and used_at is null and expires_at > ?`,
        )
        .get(userId, purpose, now)!.n > 0
    );
  }

  // a fresh token's hash on the unused link, and its expiry from now;
  // false when the link was revoked since its email was queued
  mint(
    userId: string,
    purpose: LinkPurpose,
    tokenHash: string,
    expiresAt: number,
  ): boolean {
    return (
      this.db
        .query(
          `update user_links set token_hash = ?, expires_at = ?
           where user_id = ? and purpose = ? and used_at is null`,
        )
        .run(tokenHash, expiresAt, userId, purpose).changes > 0
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

  // the one write that uses a link: unused, unexpired and its user
  // enabled, or nothing; the link's user and purpose
  use(
    tokenHash: string,
    now: number,
  ): { userId: string; purpose: LinkPurpose } | null {
    const raw = this.db
      .query<
        { user_id: string; purpose: LinkPurpose },
        [number, string, number]
      >(
        `update user_links set used_at = ?
         where token_hash = ? and used_at is null and expires_at > ?
           and user_id in (select id from users where disabled = 0)
         returning user_id, purpose`,
      )
      .get(now, tokenHash, now);
    return raw === null ? null : { userId: raw.user_id, purpose: raw.purpose };
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

  // used or not, a link past its expiry is of no use
  sweep(now: number): number {
    return this.db
      .query("delete from user_links where expires_at <= ?")
      .run(now).changes;
  }
}
