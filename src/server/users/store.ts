// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { UserSummary } from "../../shared/contracts/user.ts";
import type { Role } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

// the row, server only: the hash never leaves this area
export type UserRow = UserSummary & {
  passwordHash: string;
  createdAt: number;
};

type Raw = {
  id: string;
  name: string;
  role: Role;
  password_hash: string;
  created_at: number;
};

const row = (raw: Raw): UserRow => ({
  id: raw.id,
  name: raw.name,
  role: raw.role,
  passwordHash: raw.password_hash,
  createdAt: raw.created_at,
});

export const summary = (user: UserRow): UserSummary => ({
  id: user.id,
  name: user.name,
  role: user.role,
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

  byName(name: string): UserRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from users where name = ?")
      .get(name);
    return raw ? row(raw) : null;
  }

  create(fields: {
    name: string;
    role: Role;
    passwordHash: string;
    now: number;
  }): UserRow {
    const id = newId();
    this.db
      .query(
        "insert into users (id, name, role, password_hash, created_at) values (?, ?, ?, ?, ?)",
      )
      .run(id, fields.name, fields.role, fields.passwordHash, fields.now);
    return this.byId(id)!;
  }
}
