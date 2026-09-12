// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Users: identity, the password hash, the one way a user is created,
// and the bootstrap of the first admin from the admin secret. A user
// is made with what belongs to it, the personal project first of all,
// in one transaction: the port below runs inside it, so a user never
// exists without its project.

import { MIN_PASSWORD, type Role } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { Log } from "../lib/log.ts";
import { profile, summary, type UserRow, UserStore } from "./store.ts";

export { profile, summary, type UserRow, UserStore };

export const ADMIN_USERNAME = "admin";
export const ADMIN_FULL_NAME = "Administrator";
export const ADMIN_SECRET = "admin";
export const MAX_PASSWORD_BYTES = 1024;

export type UserDeps = {
  db: Db;
  store: UserStore;
  // what a new user is made with, inside the same transaction
  onCreated: (user: UserRow) => void;
};

export type BootstrapDeps = UserDeps & {
  // the secrets port: the bare value or null
  secret: (name: string) => string | null;
  clock: Clock;
  log: Log;
};

export function createUser(
  deps: UserDeps,
  fields: {
    username: string;
    fullName: string;
    role: Role;
    passwordHash: string;
    now: number;
  },
): UserRow {
  return transact(deps.db, () => {
    const user = deps.store.create(fields);
    deps.onCreated(user);
    return { result: user };
  });
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

// When the users table is empty and admin.key holds a password, create
// the admin with its hash and drop the plain value. A non-empty table
// ignores the file, so it bootstraps and never resets.
export async function bootstrap(deps: BootstrapDeps): Promise<UserRow | null> {
  if (deps.store.count() > 0) return null;
  const password = deps.secret(ADMIN_SECRET);
  if (password === null) {
    deps.log(`no users and no ${ADMIN_SECRET}.key; nobody can sign in`);
    return null;
  }
  // the same cap the login parser applies, or the admin could never sign
  // in; the same floor a new password has, or the first admin would be
  // the one account allowed what the profile page refuses
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    deps.log(
      `${ADMIN_SECRET}.key is over ${MAX_PASSWORD_BYTES} bytes; nobody can sign in`,
    );
    return null;
  }
  if (password.length < MIN_PASSWORD) {
    deps.log(
      `${ADMIN_SECRET}.key is under ${MIN_PASSWORD} characters; nobody can sign in`,
    );
    return null;
  }
  const user = createUser(deps, {
    username: ADMIN_USERNAME,
    fullName: ADMIN_FULL_NAME,
    role: "admin",
    passwordHash: await hashPassword(password),
    now: deps.clock(),
  });
  deps.log(`created ${ADMIN_USERNAME} from ${ADMIN_SECRET}.key`);
  return user;
}
