// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Users: identity, the password hash, the one way a user is created,
// and the bootstrap of the first admin from the admin secret. A user
// is made with what belongs to it, the personal project first of all,
// in one transaction: the port below runs inside it, so a user never
// exists without its project.

import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD,
  type Role,
} from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import {
  account,
  meOf,
  profile,
  summary,
  type UserRow,
  UserStore,
} from "./store.ts";

export { account, meOf, profile, summary, type UserRow, UserStore };

export type UserFields = {
  username: string;
  fullName: string;
  email: string;
  role: Role;
  passwordHash: string;
  mustChangePassword: boolean;
  now: number;
};

export const ADMIN_USERNAME = "admin";
export const ADMIN_EMAIL = "admin@1ctx.dev";
export const ADMIN_FULL_NAME = "Administrator";
export const ADMIN_SECRET = "admin";

// the projects port: the personal project a user is made with, inside
// the same transaction, so a user never exists without it
export type ProjectsPort = {
  createPersonal(fields: { userId: string; name: string; now: number }): void;
};

export type UserDeps = {
  db: Db;
  store: UserStore;
  projects: ProjectsPort;
};

export type BootstrapDeps = UserDeps & {
  // the secrets port: the bare value or null
  secret: (name: string) => string | null;
  clock: Clock;
  log: Log;
};

export function createUser(deps: UserDeps, fields: UserFields): UserRow {
  return transact(deps.db, () => {
    const user = deps.store.create(fields);
    deps.projects.createPersonal({
      userId: user.id,
      name: user.username,
      now: user.createdAt,
    });
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
    email: ADMIN_EMAIL,
    role: "admin",
    passwordHash: await hashPassword(password),
    mustChangePassword: false,
    now: deps.clock(),
  });
  deps.log(`created ${ADMIN_USERNAME} from ${ADMIN_SECRET}.key`);
  return user;
}

export type UsersDeps = {
  db: Db;
  secret: (name: string) => string | null;
  clock: Clock;
  log: Log;
  projects: ProjectsPort;
};

export type Users = {
  store: UserStore;
  list(): UserRow[];
  byId(id: string): UserRow | null;
  byUsername(username: string): UserRow | null;
  byEmail(email: string): UserRow | null;
  setDetails(id: string, fields: { fullName: string; about: string }): void;
  setUsername(id: string, username: string): void;
  setEmail(id: string, email: string): void;
  setRole(id: string, role: Role): void;
  setDisabled(id: string, disabled: boolean): void;
  setMustChangePassword(id: string, required: boolean): void;
  setPasswordHash(id: string, hash: string): void;
  countAdmins(): number;
  createUser(fields: UserFields): UserRow;
  // the first admin from admin.key, once the areas it is made with exist
  bootstrap(): Promise<UserRow | null>;
  routes: RouteDescriptor[];
};

export function usersArea(deps: UsersDeps): Users {
  const store = new UserStore(deps.db);
  const userDeps: UserDeps = { db: deps.db, store, projects: deps.projects };
  return {
    store,
    list: () => store.list(),
    byId: (id) => store.byId(id),
    byUsername: (username) => store.byUsername(username),
    byEmail: (email) => store.byEmail(email),
    setDetails: (id, fields) => store.setDetails(id, fields),
    setUsername: (id, username) => store.setUsername(id, username),
    setEmail: (id, email) => store.setEmail(id, email),
    setRole: (id, role) => store.setRole(id, role),
    setDisabled: (id, disabled) => store.setDisabled(id, disabled),
    setMustChangePassword: (id, required) =>
      store.setMustChangePassword(id, required),
    setPasswordHash: (id, hash) => store.setPasswordHash(id, hash),
    countAdmins: () => store.countAdmins(),
    createUser: (fields) => createUser(userDeps, fields),
    bootstrap: () => bootstrap({ ...userDeps, ...deps }),
    routes: [],
  };
}
