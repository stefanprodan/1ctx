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

  // a password change keeps the tab that changed it
  deleteOthers(userId: string, keepId: string): number {
    return this.db
      .query("delete from logins where user_id = ? and id != ?")
      .run(userId, keepId).changes;
  }

  deleteForUser(userId: string): number {
    return this.db.query("delete from logins where user_id = ?").run(userId)
      .changes;
  }

  // the owners come back so the sockets behind them can be closed
  deleteExpired(now: number): { id: string; userId: string }[] {
    const rows = this.db
      .query<{ id: string; user_id: string }, [number]>(
        "select id, user_id from logins where expires_at <= ?",
      )
      .all(now);
    this.db.query("delete from logins where expires_at <= ?").run(now);
    return rows.map((r) => ({ id: r.id, userId: r.user_id }));
  }
}
