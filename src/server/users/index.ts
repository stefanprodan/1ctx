// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Users: identity, the one way a user is created, and the bootstrap of
// the first admin from the admin key file. A user
// is made with what belongs to it, the personal project first of all,
// in one transaction: the port below runs inside it, so a user never
// exists without its project.

import type { Role } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { Log } from "../lib/log.ts";
import { isAdminKey } from "./rules.ts";
import {
  account,
  isPlaceholderEmail,
  meOf,
  profile,
  summary,
  type UserFields,
  type UserRow,
  UserStore,
} from "./store.ts";

export {
  ADMIN_KEY_KIND,
  ADMIN_KEY_PREFIX,
  adminKeyName,
  isAdminKey,
  newAdminKey,
  usernameOfKey,
} from "./rules.ts";
export {
  account,
  isPlaceholderEmail,
  meOf,
  profile,
  summary,
  type UserFields,
  type UserRow,
  UserStore,
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
};

export function createUser(deps: UserDeps, fields: UserFields): UserRow {
  return transact(deps.db, () => {
    const user = deps.store.create(fields);
    deps.projects.createPersonal({ userId: user.id, now: user.createdAt });
    return { result: user };
  });
}

// nobody can sign in until this file is right, so every line names it
const ADMIN_FILE = `${ADMIN_SECRET}.key`;

// the first start cannot go on without its admin
export class BootstrapError extends Error {
  constructor(
    readonly file: string,
    readonly reason: "missing" | "no admin key",
  ) {
    super(
      `${file} ${reason === "missing" ? "is missing" : "holds no admin key"}`,
    );
  }
}

// When the users table is empty, the first admin comes from
// user-admin.key, which must hold an admin key: the admin signs in with
// that file, so nothing is stored. A non-empty table ignores the file.
export function bootstrap(deps: BootstrapDeps): UserRow | null {
  if (deps.store.count() > 0) return null;
  const key = deps.secret(ADMIN_SECRET);
  if (key === null) throw new BootstrapError(ADMIN_FILE, "missing");
  if (!isAdminKey(key)) throw new BootstrapError(ADMIN_FILE, "no admin key");
  const user = createUser(deps, {
    username: ADMIN_USERNAME,
    fullName: ADMIN_FULL_NAME,
    email: ADMIN_EMAIL,
    role: "admin",
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
  // every user's pick of a deleted agent goes, so their start moves on
  clearAgent(agentId: string): void;
  setDisabled(id: string, disabled: boolean): void;
  setEmailFromAgents(id: string, on: boolean): void;
  setSignedIn(id: string, at: number): void;
  countAdmins(): number;
  createUser(fields: UserFields): UserRow;
  // the first admin from user-admin.key, once the areas it is made with
  // exist; throws a BootstrapError when the file cannot make one
  bootstrap(): UserRow | null;
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
    setTz: (id, tz) => store.setTz(id, tz),
    setAgent: (id, agentId) => store.setAgent(id, agentId),
    clearAgent: (agentId) => store.clearAgent(agentId),
    setDisabled: (id, disabled) => store.setDisabled(id, disabled),
    setEmailFromAgents: (id, on) => store.setEmailFromAgents(id, on),
    setSignedIn: (id, at) => store.setSignedIn(id, at),
    countAdmins: () => store.countAdmins(),
    createUser: (fields) => createUser(userDeps, fields),
    bootstrap: () => bootstrap({ ...userDeps, ...deps }),
  };
}
