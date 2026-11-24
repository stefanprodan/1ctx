// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Access: logins, the principal, the login, logout and me routes, the
// admin keys, the links an email carries, passkeys, the signed-in
// profile routes, and admin user management.

import type { Db, Transaction } from "../db/index.ts";
import { after, type Clock, MINUTE_MS } from "../lib/clock.ts";
import type { Principal, RouteDescriptor } from "../lib/http.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { UserRow } from "../users/index.ts";
import { actingWrite } from "./acting.ts";
import { adminKeys, type KeyFilesPort } from "./admin-keys.ts";
import {
  type Auth,
  type ProjectsPort as AuthProjectsPort,
  type UsersPort as AuthUsersPort,
  auth,
} from "./auth.ts";
import {
  type BoardUsagePort,
  boardRoutes,
  type PresencePort,
} from "./board.ts";
import {
  type ActivityPort,
  type ProjectsPort as DirectoryProjectsPort,
  type UsersPort as DirectoryUsersPort,
  directoryRoutes,
} from "./directory.ts";
import { keyRoutes } from "./key-routes.ts";
import { AccessKeyStore } from "./key-store.ts";
import {
  type UsersPort as LinkRoutesUsersPort,
  linkLive,
  linkRoutes,
  type PagesPort,
} from "./link-routes.ts";
import { LinkStore } from "./link-store.ts";
import {
  type EmailPort,
  type UsersPort as LinksUsersPort,
  links as linksOf,
} from "./links.ts";
import { passkeyRoutes } from "./passkeys/routes.ts";
import { PasskeyStore } from "./passkeys/store.ts";
import {
  type UsersPort as ProfileUsersPort,
  profileRoutes,
} from "./profile.ts";
import {
  type DictationPort,
  type UsersPort as LoginUsersPort,
  loginGuard,
  OPTIONS_LIMIT,
  routes,
} from "./routes.ts";
import { LoginStore } from "./store.ts";
import type { TaskClaimsPort } from "./task-claims.ts";
import {
  type UsersPort as AdminUsersPort,
  type UsersProjectsPort,
  type UsersUsagePort,
  usersRoutes,
} from "./users.ts";
import { VISIT_RETENTION_MS, VisitStore } from "./visits.ts";

export {
  COOKIE as LOGIN_COOKIE,
  cookieValue,
  LOGIN_TTL_MS,
  TOUCH_AFTER_MS,
} from "./auth.ts";
export { ASK_COOKIE } from "./link-routes.ts";
export {
  parseAbout,
  parseEmail,
  parseFullName,
  parseTz,
} from "./parse.ts";

export type AccessDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  // the Secure attribute: on when the app is served over TLS
  secureCookie: boolean;
  accessKeysPerUser(): number;
  users: AuthUsersPort &
    LoginUsersPort &
    ProfileUsersPort &
    AdminUsersPort &
    DirectoryUsersPort &
    LinksUsersPort &
    LinkRoutesUsersPort;
  projects: AuthProjectsPort & DirectoryProjectsPort & UsersProjectsPort;
  usage: UsersUsagePort & BoardUsagePort;
  // a person's posts, chats and manual runs: a closure, since sessions
  // is built after access
  activity: ActivityPort;
  // a closure, the socket is built after access
  presence: PresencePort;
  email: EmailPort;
  dictation: DictationPort;
  taskClaims: TaskClaimsPort;
  // the user- key files: the admin keys
  keyFiles: KeyFilesPort;
  // the server-drawn pages a link's form post answers with
  pages: PagesPort;
};

export type Access = Auth & {
  unavailableKeys(ids: readonly string[]): string[];
  // drop the visits past every window; how many went
  sweepVisits(): number;
  // drop the links past their expiry, used or not, the asks past their
  // day and the passkey challenges past theirs; how many went
  sweepLinks(): number;
  // whether a token opens a live link, for the link page
  linkLive(token: string): boolean;
  // the work a link ask left after its answer, for the shutdown and tests
  settled(): Promise<void>;
  // at shutdown: a link ask from here answers and does nothing; resolves
  // once every one before ran
  closeLinks(): Promise<void>;
  // the minute's check of every key login, from now until stopped; logs
  // the files that hold one key, which sign in neither
  startKeyChecks(): void;
  stopKeyChecks(): void;
  // a write after a body, for an area built before access: its caller
  // read again in the transaction (actingUser())
  actingWrite<T>(
    principal: Principal,
    role: "admin" | null,
    body: (user: UserRow) => Transaction<T>,
  ): T;
  routes: RouteDescriptor[];
};

export function accessArea(deps: AccessDeps): Access {
  const logins = new LoginStore(deps.db);
  const keys = new AccessKeyStore(deps.db);
  const visits = new VisitStore(deps.db);
  const linkStore = new LinkStore(deps.db);
  const passkeys = new PasskeyStore(deps.db);
  const keyFiles = adminKeys(deps.keyFiles, deps.log);
  const built = auth({
    db: deps.db,
    logins,
    keys,
    accessKeysPerUser: deps.accessKeysPerUser,
    visits,
    users: deps.users,
    projects: deps.projects,
    adminKeys: keyFiles,
    passkeys,
    clock: deps.clock,
    secureCookie: deps.secureCookie,
  });
  let stopChecks: (() => void) | null = null;
  const checkLoop = () => {
    stopChecks = after(deps.clock, MINUTE_MS, () => {
      try {
        const ended = built.checkKeyLogins();
        if (ended.logins > 0 || ended.passkeys > 0) {
          deps.log.info("key logins ended", ended);
        }
      } catch (err) {
        deps.log.warn("key check failed", errorFields(err));
      }
      if (stopChecks !== null) checkLoop();
    });
  };
  const links = linksOf({
    db: deps.db,
    clock: deps.clock,
    log: deps.log,
    store: linkStore,
    users: deps.users,
    email: deps.email,
  });
  const guard = loginGuard(deps.clock, deps.log);
  const optionsGuard = loginGuard(deps.clock, deps.log, OPTIONS_LIMIT);
  return {
    ...built,
    unavailableKeys: (ids) =>
      keys.unavailable(ids, deps.clock(), deps.accessKeysPerUser()),
    sweepVisits: () => visits.deleteBefore(deps.clock() - VISIT_RETENTION_MS),
    sweepLinks: () =>
      linkStore.sweep(deps.clock()) +
      passkeys.deleteExpiredChallenges(deps.clock()),
    linkLive: (token) => linkLive(linkStore, deps.users, deps.clock(), token),
    settled: () => links.settled(),
    closeLinks: () => links.close(),
    startKeyChecks() {
      for (const files of keyFiles.duplicates()) {
        deps.log.warn("admin keys shared", {
          files: files.map((name) => `${name}.key`).join(","),
        });
      }
      if (stopChecks === null) checkLoop();
    },
    actingWrite: (principal, role, body) =>
      actingWrite(
        {
          db: deps.db,
          logins,
          users: deps.users,
          adminKeys: keyFiles,
          clock: deps.clock,
        },
        principal,
        role,
        body,
      ),
    stopKeyChecks() {
      const stop = stopChecks;
      stopChecks = null;
      stop?.();
    },
    routes: [
      ...routes({
        db: deps.db,
        auth: built,
        users: deps.users,
        adminKeys: keyFiles,
        clock: deps.clock,
        log: deps.log,
        guard,
        email: deps.email,
        dictation: deps.dictation,
      }),
      ...linkRoutes({
        db: deps.db,
        auth: built,
        store: linkStore,
        links,
        users: deps.users,
        email: deps.email,
        pages: deps.pages,
        clock: deps.clock,
        log: deps.log,
        secureCookie: deps.secureCookie,
        guard,
      }),
      ...profileRoutes({
        db: deps.db,
        users: deps.users,
        email: deps.email,
      }),
      ...passkeyRoutes({
        db: deps.db,
        store: passkeys,
        auth: built,
        logins,
        users: deps.users,
        adminKeys: keyFiles,
        email: deps.email,
        clock: deps.clock,
        log: deps.log,
        guard,
        optionsGuard,
      }),
      ...usersRoutes({
        db: deps.db,
        logins,
        keys,
        taskClaims: deps.taskClaims,
        log: deps.log,
        visits,
        users: deps.users,
        projects: deps.projects,
        usage: deps.usage,
        adminKeys: keyFiles,
        clock: deps.clock,
        email: deps.email,
        links,
        passkeys,
      }),
      ...keyRoutes({
        db: deps.db,
        keys,
        taskClaims: deps.taskClaims,
        logins,
        users: deps.users,
        adminKeys: keyFiles,
        auth: built,
        accessKeysPerUser: deps.accessKeysPerUser,
        clock: deps.clock,
        log: deps.log,
      }),
      ...boardRoutes({
        visits,
        logins,
        presence: deps.presence,
        users: deps.users,
        usage: deps.usage,
        projects: deps.projects,
        clock: deps.clock,
      }),
      ...directoryRoutes({
        users: deps.users,
        projects: deps.projects,
        activity: deps.activity,
        visits,
        clock: deps.clock,
      }),
    ],
  };
}

export { RateLimit } from "./ratelimit.ts";
