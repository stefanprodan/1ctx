// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Db, transact } from "../db/index.ts";
import { loginRevoked } from "../lib/bus.ts";
import {
  type Clock,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  zoneOrUtc,
} from "../lib/clock.ts";
import { Forbidden, NotFound, Unauthorized } from "../lib/errors.ts";
import type { Policy, Principal, Via } from "../lib/http.ts";
import { newToken, sha256 } from "../lib/ids.ts";
import { type ProjectRow, visible } from "../projects/index.ts";
import { daysWindow } from "../usage/index.ts";
import type { UserRow } from "../users/index.ts";
import { type AdminKeys, loginHolds } from "./admin-keys.ts";
import { type AccessKeyStore, keyAvailable, keysEnabled } from "./key-store.ts";
import type { Login, LoginStore } from "./store.ts";
import type { VisitStore } from "./visits.ts";

export const COOKIE = "login";
export const LOGIN_TTL_MS = 30 * DAY_MS;
export const TOUCH_AFTER_MS = HOUR_MS;

export type UsersPort = {
  byId(id: string): UserRow | null;
  setSignedIn(id: string, at: number): void;
};

export type ProjectsPort = {
  byId(id: string): ProjectRow | null;
  isMember(projectId: string, userId: string): boolean;
  memberProjectIds(userId: string): string[];
  teamProjectIds(): string[];
};

export type AuthDeps = {
  db: Db;
  logins: LoginStore;
  keys: AccessKeyStore;
  accessKeysPerUser(): number;
  visits: VisitStore;
  users: UsersPort;
  projects: ProjectsPort;
  adminKeys: AdminKeys;
  clock: Clock;
  // the Secure attribute: on when the app is served over TLS
  secureCookie: boolean;
};

// what the router learns from a request's cookie: who, and whether the
// cookie was renewed and must ride back on the response
export type Resolution = {
  principal: Principal | null;
  setCookie: string | null;
};

export type Auth = {
  // the route's policy picks the credential: the bearer under key, the
  // cookie under every other. A null principal when there is none, it
  // is unknown, or it expired
  resolve(req: Request, policy: Policy): Resolution;
  // the principal again from the current user row, for a long-lived
  // socket; null, and a key login ended, once its key no longer holds
  refresh(principal: Principal): Principal | null;
  // a new login for a user, by an admin key's hash or by email (null):
  // the row and the Set-Cookie header value
  open(
    user: UserRow,
    keyDigest: string | null,
  ): { login: Login; setCookie: string };
  // revoke one login; the cleared cookie header value
  close(loginId: string): string;
  // drop the rows whose expiry passed, telling the socket layer about
  // each; how many went
  sweep(): number;
  // end every key login whose key no longer holds; how many went
  checkKeyLogins(): number;
  // the project, when the principal may see it; the same 404 whether it
  // is not there or is not theirs to see, so neither leaks
  project(principal: Principal, id: string): ProjectRow;
  // every project the user may see, by the same rule: the memberships,
  // plus every team project for an admin; null for a user that is gone
  visibleProjectIds(userId: string): string[] | null;
  // the projects a principal reaches: what the user sees, narrowed by a
  // key's projects; every list a key reads goes through it
  reachableProjectIds(principal: Principal): string[];
  // inside a write's transaction: refuses a key revoked, expired, whose
  // user can no longer use it, or whose user lost the project since the
  // router resolved it; a login passes
  checkKey(principal: Principal, projectId: string): void;
};

export function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function auth(deps: AuthDeps): Auth {
  const attrs = (maxAge: number) =>
    `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${deps.secureCookie ? "; Secure" : ""}`;
  const clearCookie = () => `${COOKIE}=; ${attrs(0)}`;
  const withToken = (token: string) =>
    `${COOKIE}=${token}; ${attrs(LOGIN_TTL_MS / 1000)}`;
  const nobody: Resolution = { principal: null, setCookie: null };
  const principalOf = (user: UserRow | null, via: Via): Principal | null =>
    user === null || user.disabled
      ? null
      : {
          userId: user.id,
          username: user.username,
          fullName: user.fullName,
          role: user.role,
          via,
        };
  const current = (userId: string, via: Via): Principal | null =>
    principalOf(deps.users.byId(userId), via);
  // by user, the zone and the next local midnight of the day a visit
  // was last written for, so a request after the day's first neither
  // reads nor writes the table
  const visited = new Map<string, { tz: string; until: number }>();
  const visit = (user: UserRow, now: number) => {
    const held = visited.get(user.id);
    if (held !== undefined && held.tz === user.tz && now < held.until) return;
    const day = daysWindow(now, zoneOrUtc(user.tz), 1);
    deps.visits.record(user.id, day.days[0]!, now);
    visited.set(user.id, { tz: user.tz, until: day.until });
  };
  // a key login whose key no longer holds is deleted, and its socket
  // told; false then
  const holds = (login: Login, user: UserRow | null): boolean => {
    if (user !== null && loginHolds(deps.adminKeys, login, user)) return true;
    endLogin(login);
    return false;
  };
  const endLogin = (login: Login) =>
    transact(deps.db, () => {
      deps.logins.delete(login.id);
      return {
        result: undefined,
        events: [loginRevoked(login.userId, login.id)],
      };
    });
  const visibleProjectIds = (userId: string): string[] | null => {
    const user = deps.users.byId(userId);
    if (user === null || user.disabled) return null;
    const ids = new Set(deps.projects.memberProjectIds(userId));
    if (user.role === "admin") {
      for (const id of deps.projects.teamProjectIds()) ids.add(id);
    }
    return [...ids];
  };
  const projectOf = (principal: Principal, id: string): ProjectRow => {
    const project = deps.projects.byId(id);
    const via = principal.via;
    const viewer =
      via.kind === "key" ? current(principal.userId, via) : principal;
    if (
      project === null ||
      viewer === null ||
      (via.kind === "key" &&
        via.projectIds !== null &&
        !via.projectIds.includes(id)) ||
      !visible(project, viewer, deps.projects.isMember(id, principal.userId))
    ) {
      throw new NotFound("no such project");
    }
    return project;
  };
  return {
    resolve(req, policy) {
      if (policy === "key") {
        const cap = deps.accessKeysPerUser();
        if (!keysEnabled(cap)) throw new NotFound();
        const bearer = /^Bearer +(1ctx_[A-Za-z0-9_-]{43})$/i.exec(
          req.headers.get("authorization") ?? "",
        );
        if (bearer === null) return nobody;
        const key = deps.keys.byTokenHash(sha256(bearer[1]!));
        const now = deps.clock();
        if (!keyAvailable(key, now, cap)) return nobody;
        const principal = current(key.userId, {
          kind: "key",
          id: key.id,
          name: key.name,
          scope: key.scope,
          projectIds: key.projectIds,
        });
        if (principal === null) return nobody;
        if (key.lastUsedAt === null || now - key.lastUsedAt >= MINUTE_MS) {
          deps.keys.touch(key.id, now);
        }
        return { principal, setCookie: null };
      }
      const token = cookieValue(req, COOKIE);
      if (token === null || token === "") return nobody;
      const login = deps.logins.byTokenHash(sha256(token));
      if (login === null) return nobody;
      const now = deps.clock();
      if (login.expiresAt <= now) {
        endLogin(login);
        return nobody;
      }
      const user = deps.users.byId(login.userId);
      if (login.keyDigest !== null && !holds(login, user)) return nobody;
      const principal = principalOf(user, { kind: "login", id: login.id });
      if (principal === null) return nobody;
      visit(user!, now);
      let setCookie: string | null = null;
      if (now - login.lastSeenAt >= TOUCH_AFTER_MS) {
        deps.logins.touch(login.id, now, now + LOGIN_TTL_MS);
        setCookie = withToken(token);
      }
      return { principal, setCookie };
    },
    refresh(principal) {
      const via = principal.via;
      const login = via.kind === "login" ? deps.logins.byId(via.id) : null;
      if (login !== null && login.keyDigest !== null) {
        const user = deps.users.byId(login.userId);
        if (!holds(login, user)) return null;
      }
      return current(principal.userId, principal.via);
    },
    open(user, keyDigest) {
      const now = deps.clock();
      const token = newToken();
      const login = deps.logins.create({
        userId: user.id,
        tokenHash: sha256(token),
        now,
        expiresAt: now + LOGIN_TTL_MS,
        keyDigest,
      });
      deps.users.setSignedIn(user.id, now);
      return { login, setCookie: withToken(token) };
    },
    close(loginId) {
      deps.logins.delete(loginId);
      return clearCookie();
    },
    sweep() {
      return transact(deps.db, () => {
        const gone = deps.logins.deleteExpired(deps.clock());
        return {
          result: gone.length,
          events: gone.map((login) => loginRevoked(login.userId, login.id)),
        };
      });
    },
    checkKeyLogins() {
      // one file read per user, however many logins they hold
      const digests = new Map<string, string | null>();
      const ended = deps.logins.keyLogins().filter((login) => {
        const user = deps.users.byId(login.userId);
        if (user === null) return true;
        const keys = {
          digestOf: (username: string) => {
            if (!digests.has(username)) {
              digests.set(username, deps.adminKeys.digestOf(username));
            }
            return digests.get(username)!;
          },
        };
        return !loginHolds(keys, login, user);
      });
      if (ended.length === 0) return 0;
      return transact(deps.db, () => {
        for (const login of ended) deps.logins.delete(login.id);
        return {
          result: ended.length,
          events: ended.map((login) => loginRevoked(login.userId, login.id)),
        };
      });
    },
    project: projectOf,
    reachableProjectIds(principal) {
      const visible = visibleProjectIds(principal.userId) ?? [];
      const via = principal.via;
      if (via.kind !== "key" || via.projectIds === null) return visible;
      const narrowed = new Set(via.projectIds);
      return visible.filter((id) => narrowed.has(id));
    },
    checkKey(principal, projectId) {
      const via = principal.via;
      if (via.kind !== "key") return;
      const cap = deps.accessKeysPerUser();
      if (!keysEnabled(cap)) throw new NotFound();
      const key = deps.keys.byId(via.id);
      if (
        !keyAvailable(key, deps.clock(), cap) ||
        key.userId !== principal.userId
      ) {
        throw new Unauthorized("access key is no longer valid");
      }
      const user = deps.users.byId(key.userId);
      if (user === null || user.disabled) throw new Forbidden();
      projectOf(principal, projectId);
    },
    visibleProjectIds,
  };
}
