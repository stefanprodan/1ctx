// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  Me,
  Profile,
  UserAccount,
  UserSummary,
} from "../../shared/contracts/user.ts";
import { DEFAULT_TZ, type Role } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

// the row, server only: the hash never leaves this area
export type UserRow = Profile & {
  passwordHash: string;
  // the agent a new chat starts on; null follows the default
  agentId: string | null;
};

type Raw = {
  id: string;
  username: string;
  full_name: string;
  email: string;
  about: string;
  role: Role;
  tz: string;
  password_hash: string;
  created_at: number;
  disabled: number;
  must_change_password: number;
  agent_id: string | null;
};

const row = (raw: Raw): UserRow => ({
  id: raw.id,
  username: raw.username,
  fullName: raw.full_name,
  email: raw.email,
  about: raw.about,
  role: raw.role,
  tz: raw.tz,
  passwordHash: raw.password_hash,
  createdAt: raw.created_at,
  disabled: raw.disabled !== 0,
  mustChangePassword: raw.must_change_password !== 0,
  agentId: raw.agent_id,
});

export const summary = (user: UserRow): UserSummary => ({
  id: user.id,
  username: user.username,
  fullName: user.fullName,
  role: user.role,
});

export const meOf = (user: UserRow): Me => ({
  ...summary(user),
  mustChangePassword: user.mustChangePassword,
});

export const account = (user: UserRow): UserAccount => ({
  ...summary(user),
  email: user.email,
  tz: user.tz,
  createdAt: user.createdAt,
  disabled: user.disabled,
  mustChangePassword: user.mustChangePassword,
});

export const profile = (user: UserRow): Profile => ({
  ...account(user),
  about: user.about,
});

export class UserStore {
  constructor(private readonly db: Db) {}

  count(): number {
    return this.db
      .query<{ n: number }, []>("select count(*) as n from users")
      .get()!.n;
  }

  countAdmins(): number {
    return this.db
      .query<{ n: number }, []>(
        "select count(*) as n from users where role = 'admin' and disabled = 0",
      )
      .get()!.n;
  }

  list(): UserRow[] {
    return this.db
      .query<Raw, []>("select * from users order by username")
      .all()
      .map(row);
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

  byEmail(email: string): UserRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from users where email = ?")
      .get(email);
    return raw ? row(raw) : null;
  }

  create(fields: {
    username: string;
    fullName: string;
    email: string;
    role: Role;
    tz?: string;
    passwordHash: string;
    mustChangePassword: boolean;
    now: number;
  }): UserRow {
    const id = newId();
    this.db
      .query(
        `insert into users
          (id, username, full_name, email, role, tz, password_hash,
           must_change_password, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.username,
        fields.fullName,
        fields.email,
        fields.role,
        fields.tz ?? DEFAULT_TZ,
        fields.passwordHash,
        fields.mustChangePassword ? 1 : 0,
        fields.now,
      );
    return this.byId(id)!;
  }

  setDetails(id: string, fields: { fullName: string; about: string }): void {
    this.db
      .query("update users set full_name = ?, about = ? where id = ?")
      .run(fields.fullName, fields.about, id);
  }

  setUsername(id: string, username: string): void {
    this.db
      .query("update users set username = ? where id = ?")
      .run(username, id);
  }

  setEmail(id: string, email: string): void {
    this.db.query("update users set email = ? where id = ?").run(email, id);
  }

  setTz(id: string, tz: string): void {
    this.db.query("update users set tz = ? where id = ?").run(tz, id);
  }

  setAgent(id: string, agentId: string | null): void {
    this.db
      .query("update users set agent_id = ? where id = ?")
      .run(agentId, id);
  }

  clearAgent(agentId: string): void {
    this.db
      .query("update users set agent_id = null where agent_id = ?")
      .run(agentId);
  }

  setRole(id: string, role: Role): void {
    this.db.query("update users set role = ? where id = ?").run(role, id);
  }

  setDisabled(id: string, disabled: boolean): void {
    this.db
      .query("update users set disabled = ? where id = ?")
      .run(disabled ? 1 : 0, id);
  }

  setMustChangePassword(id: string, required: boolean): void {
    this.db
      .query("update users set must_change_password = ? where id = ?")
      .run(required ? 1 : 0, id);
  }

  setPasswordHash(id: string, passwordHash: string): void {
    this.db
      .query("update users set password_hash = ? where id = ?")
      .run(passwordHash, id);
  }
}
