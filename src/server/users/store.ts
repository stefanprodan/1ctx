// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Profile, UserSummary } from "../../shared/contracts/user.ts";
import type { Role } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

// the row, server only: the hash never leaves this area
export type UserRow = Profile & {
  passwordHash: string;
};

type Raw = {
  id: string;
  username: string;
  full_name: string;
  about: string;
  role: Role;
  password_hash: string;
  created_at: number;
};

const row = (raw: Raw): UserRow => ({
  id: raw.id,
  username: raw.username,
  fullName: raw.full_name,
  about: raw.about,
  role: raw.role,
  passwordHash: raw.password_hash,
  createdAt: raw.created_at,
});

export const summary = (user: UserRow): UserSummary => ({
  id: user.id,
  username: user.username,
  fullName: user.fullName,
  role: user.role,
});

export const profile = (user: UserRow): Profile => ({
  ...summary(user),
  about: user.about,
  createdAt: user.createdAt,
});

export class UserStore {
  constructor(private readonly db: Db) {}

  count(): number {
    return this.db
      .query<{ n: number }, []>("select count(*) as n from users")
      .get()!.n;
  }

  byId(id: string): UserRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from users where id = ?")
      .get(id);
    return raw ? row(raw) : null;
  }

  byUsername(username: string): UserRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from users where username = ?")
      .get(username);
    return raw ? row(raw) : null;
  }

  create(fields: {
    username: string;
    fullName: string;
    role: Role;
    passwordHash: string;
    now: number;
  }): UserRow {
    const id = newId();
    this.db
      .query(
        "insert into users (id, username, full_name, role, password_hash, created_at) values (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        fields.username,
        fields.fullName,
        fields.role,
        fields.passwordHash,
        fields.now,
      );
    return this.byId(id)!;
  }

  setDetails(id: string, fields: { fullName: string; about: string }): void {
    this.db
      .query("update users set full_name = ?, about = ? where id = ?")
      .run(fields.fullName, fields.about, id);
  }

  setPasswordHash(id: string, passwordHash: string): void {
    this.db
      .query("update users set password_hash = ? where id = ?")
      .run(passwordHash, id);
  }
}
