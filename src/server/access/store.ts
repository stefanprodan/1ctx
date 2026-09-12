// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

// a login is the row behind a cookie; never "session", which is the
// domain noun
export type Login = {
  id: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
};

type Raw = {
  id: string;
  user_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
};

const row = (raw: Raw): Login => ({
  id: raw.id,
  userId: raw.user_id,
  createdAt: raw.created_at,
  lastSeenAt: raw.last_seen_at,
  expiresAt: raw.expires_at,
});

export class LoginStore {
  constructor(private readonly db: Db) {}

  create(fields: {
    userId: string;
    tokenHash: string;
    now: number;
    expiresAt: number;
  }): Login {
    const id = newId();
    this.db
      .query(
        "insert into logins (id, user_id, token_hash, created_at, last_seen_at, expires_at) values (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        fields.userId,
        fields.tokenHash,
        fields.now,
        fields.now,
        fields.expiresAt,
      );
    return this.byId(id)!;
  }

  byId(id: string): Login | null {
    const raw = this.db
      .query<Raw, [string]>(
        "select id, user_id, created_at, last_seen_at, expires_at from logins where id = ?",
      )
      .get(id);
    return raw ? row(raw) : null;
  }

  byTokenHash(tokenHash: string): Login | null {
    const raw = this.db
      .query<Raw, [string]>(
        "select id, user_id, created_at, last_seen_at, expires_at from logins where token_hash = ?",
      )
      .get(tokenHash);
    return raw ? row(raw) : null;
  }

  touch(id: string, now: number, expiresAt: number): void {
    this.db
      .query("update logins set last_seen_at = ?, expires_at = ? where id = ?")
      .run(now, expiresAt, id);
  }

  delete(id: string): void {
    this.db.query("delete from logins where id = ?").run(id);
  }

  // every login of a user but one: a password change keeps the tab
  // that changed it
  deleteOthers(userId: string, keepId: string): number {
    return this.db
      .query("delete from logins where user_id = ? and id != ?")
      .run(userId, keepId).changes;
  }

  deleteExpired(now: number): number {
    return this.db.query("delete from logins where expires_at <= ?").run(now)
      .changes;
  }
}
