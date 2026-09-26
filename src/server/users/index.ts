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
  // UTC when left out: the first admin, whose zone nobody typed
  tz?: string;
  passwordHash: string;
  mustChangePassword: boolean;
  now: number;
};

export const ADMIN_USERNAME = "admin";
export const ADMIN_EMAIL = "admin@1ctx.dev";
export const ADMIN_FULL_NAME = "Administrator";
export const ADMIN_SECRET = "user-admin";

// the projects port: the personal project a user is made with, inside
// the same transaction, so a user never exists without it
export type ProjectsPort = {
  createPersonal(fields: { userId: string; now: number }): void;
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
  passwordCost?: PasswordCost;
};

export function createUser(deps: UserDeps, fields: UserFields): UserRow {
  return transact(deps.db, () => {
    const user = deps.store.create(fields);
    deps.projects.createPersonal({ userId: user.id, now: user.createdAt });
    return { result: user };
  });
}

// argon2id's cost, Bun's defaults written out; a test composes with the
// least, since every test app hashes and checks the admin's password
// and the cost is the whole run's time otherwise. A check reads the
// cost from the hash, so it follows whatever made the hash
export type PasswordCost = { memoryCost: number; timeCost: number };
export const PASSWORD_COST: PasswordCost = { memoryCost: 65_536, timeCost: 2 };

export async function hashPassword(
  password: string,
  cost: PasswordCost = PASSWORD_COST,
): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id", ...cost });
}

export function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

// When the users table is empty and user-admin.key holds a password, create
// the admin with its hash and drop the plain value. A non-empty table
// ignores the file, so it bootstraps and never resets.
// nobody can sign in until this file is right, so every line names it
const ADMIN_FILE = `${ADMIN_SECRET}.key`;

export async function bootstrap(deps: BootstrapDeps): Promise<UserRow | null> {
  if (deps.store.count() > 0) return null;
  const password = deps.secret(ADMIN_SECRET);
  if (password === null) {
    deps.log.warn("admin not created", { file: ADMIN_FILE, reason: "missing" });
    return null;
  }
  // the same cap the login parser applies, or the admin could never sign
  // in; the same floor a new password has, or the first admin would be
  // the one account allowed what the profile page refuses
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    deps.log.warn("admin not created", {
      file: ADMIN_FILE,
      reason: "too long",
      limit: MAX_PASSWORD_BYTES,
    });
    return null;
  }
  if (password.length < MIN_PASSWORD) {
    deps.log.warn("admin not created", {
      file: ADMIN_FILE,
      reason: "too short",
      limit: MIN_PASSWORD,
    });
    return null;
  }
  const user = createUser(deps, {
    username: ADMIN_USERNAME,
    fullName: ADMIN_FULL_NAME,
    email: ADMIN_EMAIL,
    role: "admin",
    passwordHash: await hashPassword(password, deps.passwordCost),
    mustChangePassword: false,
    now: deps.clock(),
  });
  deps.log.info("admin created", { user: ADMIN_USERNAME, file: ADMIN_FILE });
  return user;
}

export type UsersDeps = {
  db: Db;
  secret: (name: string) => string | null;
  clock: Clock;
  log: Log;
  projects: ProjectsPort;
  passwordCost?: PasswordCost;
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
  setTz(id: string, tz: string): void;
  setAgent(id: string, agentId: string | null): void;
  setDisabled(id: string, disabled: boolean): void;
  setMustChangePassword(id: string, required: boolean): void;
  setPasswordHash(id: string, hash: string): void;
  countAdmins(): number;
  createUser(fields: UserFields): UserRow;
  // a password's hash at the composed cost
  hashPassword(password: string): Promise<string>;
  // a hash no password was set for, at the same cost, so a login for a
  // missing user costs what a wrong password does
  nobodyHash(): Promise<string>;
  // the first admin from user-admin.key, once the areas it is made with exist
  bootstrap(): Promise<UserRow | null>;
  routes: RouteDescriptor[];
};

export function usersArea(deps: UsersDeps): Users {
  const store = new UserStore(deps.db);
  const cost = deps.passwordCost ?? PASSWORD_COST;
  let nobody: Promise<string> | null = null;
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
    setTz: (id, tz) => store.setTz(id, tz),
    setAgent: (id, agentId) => store.setAgent(id, agentId),
    setDisabled: (id, disabled) => store.setDisabled(id, disabled),
    setMustChangePassword: (id, required) =>
      store.setMustChangePassword(id, required),
    setPasswordHash: (id, hash) => store.setPasswordHash(id, hash),
    countAdmins: () => store.countAdmins(),
    createUser: (fields) => createUser(userDeps, fields),
    hashPassword: (password) => hashPassword(password, cost),
    nobodyHash: () => {
      nobody ??= hashPassword("nobody", cost);
      return nobody;
    },
    bootstrap: () => bootstrap({ ...userDeps, ...deps, passwordCost: cost }),
    routes: [],
  };
}
