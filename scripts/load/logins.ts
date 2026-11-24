// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A run's logins, minted straight into a stopped database: no password
// or key, and no route that skips sign-in. Each user gets a fresh login
// row; the tokens stay with the driver, which sends them as the login
// cookie. Never in the builder, whose clock is fixed in the past.

import type { Database } from "bun:sqlite";
import { newId, newToken, sha256 } from "../../src/server/lib/ids.ts";

// a step and its setup end well within it; the server slides it on use
const LOGIN_MS = 24 * 3_600_000;

// by username
export type Logins = Record<string, string>;

export function newLogins(usernames: string[]): {
  tokens: Logins;
  hashes: Logins;
} {
  const tokens: Logins = {};
  const hashes: Logins = {};
  for (const name of usernames) {
    const token = newToken();
    tokens[name] = token;
    hashes[name] = sha256(token);
  }
  return { tokens, hashes };
}

// inside the caller's transaction: every named user's earlier logins
// go and one login per hash is opened; an unknown or disabled user fails
export function mintLogins(db: Database, hashes: Logins, now: number): number {
  const userId = db.query<{ id: string }, [string]>(
    "select id from users where username = ? and disabled = 0",
  );
  const clear = db.query("delete from logins where user_id = ?");
  const insert = db.query(
    `insert into logins (id, user_id, token_hash, created_at, last_seen_at,
       expires_at) values (?, ?, ?, ?, ?, ?)`,
  );
  let made = 0;
  for (const [name, hash] of Object.entries(hashes)) {
    const id = userId.get(name)?.id;
    if (id === undefined) throw new Error(`no enabled user ${name}`);
    clear.run(id);
    insert.run(newId(), id, hash, now, now, now + LOGIN_MS);
    made++;
  }
  return made;
}

// the names whose login is not the one minted for them
export function unminted(db: Database, hashes: Logins, now: number): string[] {
  const live = db.query<{ n: number }, [string, string, number]>(
    `select count(*) as n from logins l join users u on u.id = l.user_id
       where u.username = ? and l.token_hash = ? and l.expires_at > ?`,
  );
  return Object.entries(hashes)
    .filter(([name, hash]) => live.get(name, hash, now)!.n !== 1)
    .map(([name]) => name);
}

export function enabledUsers(db: Database): string[] {
  return db
    .query<{ username: string }, []>(
      "select username from users where disabled = 0 order by username",
    )
    .all()
    .map((u) => u.username);
}
