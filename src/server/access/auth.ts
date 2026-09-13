// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Access: the cookie, the login row behind it, and the principal the
// router hands to every handler. The cookie carries a random token; the
// row holds its hash. Thirty days sliding: a request past an hour since
// the last touch pushes the row's expiry out and re-sends the cookie
// with a full Max-Age, so the browser's copy slides with it.

import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { NotFound } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import { newToken, sha256 } from "../lib/ids.ts";
import { type ProjectRow, visible } from "../projects/index.ts";
import type { UserRow } from "../users/index.ts";
import type { Login, LoginStore } from "./store.ts";

export const COOKIE = "login";
export const LOGIN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const TOUCH_AFTER_MS = 60 * 60 * 1000;

export type UsersPort = {
  byId(id: string): UserRow | null;
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
  users: UsersPort;
  projects: ProjectsPort;
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
  // null principal when there is no cookie, it is unknown, or it expired
  resolve(req: Request): Resolution;
  // the principal again from the current user row, for a long-lived socket
  refresh(principal: Principal): Principal | null;
  // a new login for a user: the row and the Set-Cookie header value
  open(user: UserRow): { login: Login; setCookie: string };
  // revoke one login; the cleared cookie header value
  close(loginId: string): string;
  clearCookie(): string;
  // drop the rows whose expiry passed, telling the socket layer about
  // each; how many went
  sweep(): number;
  // the project, when the principal may see it; the same 404 whether it
  // is not there or is not theirs to see, so neither leaks
  project(principal: Principal, id: string): ProjectRow;
  // every project the user may see, by the same rule: the memberships,
  // plus every team project for an admin; null for a user that is gone
  visibleProjectIds(userId: string): string[] | null;
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
  const current = (userId: string, loginId: string): Principal | null => {
    const user = deps.users.byId(userId);
    return user === null || user.disabled
      ? null
      : {
          userId: user.id,
          username: user.username,
          fullName: user.fullName,
          role: user.role,
          mustChangePassword: user.mustChangePassword,
          loginId,
        };
  };
  return {
    resolve(req) {
      const token = cookieValue(req, COOKIE);
      if (token === null || token === "") return nobody;
      const login = deps.logins.byTokenHash(sha256(token));
      if (login === null) return nobody;
      const now = deps.clock();
      if (login.expiresAt <= now) {
        transact(deps.db, () => {
          deps.logins.delete(login.id);
          return {
            result: undefined,
            events: [
              {
                type: "login.revoked" as const,
                data: { userId: login.userId, loginId: login.id },
              },
            ],
          };
        });
        return nobody;
      }
      const principal = current(login.userId, login.id);
      if (principal === null) return nobody;
      let setCookie: string | null = null;
      if (now - login.lastSeenAt >= TOUCH_AFTER_MS) {
        deps.logins.touch(login.id, now, now + LOGIN_TTL_MS);
        setCookie = withToken(token);
      }
      return { principal, setCookie };
    },
    refresh(principal) {
      return current(principal.userId, principal.loginId);
    },
    open(user) {
      const now = deps.clock();
      const token = newToken();
      const login = deps.logins.create({
        userId: user.id,
        tokenHash: sha256(token),
        now,
        expiresAt: now + LOGIN_TTL_MS,
      });
      return { login, setCookie: withToken(token) };
    },
    close(loginId) {
      deps.logins.delete(loginId);
      return clearCookie();
    },
    clearCookie,
    sweep() {
      return transact(deps.db, () => {
        const gone = deps.logins.deleteExpired(deps.clock());
        return {
          result: gone.length,
          events: gone.map((login) => ({
            type: "login.revoked" as const,
            data: { userId: login.userId, loginId: login.id },
          })),
        };
      });
    },
    project(principal, id) {
      const project = deps.projects.byId(id);
      if (
        project === null ||
        !visible(
          project,
          principal,
          deps.projects.isMember(id, principal.userId),
        )
      ) {
        throw new NotFound("no such project");
      }
      return project;
    },
    visibleProjectIds(userId) {
      const user = deps.users.byId(userId);
      if (user === null || user.disabled) return null;
      const ids = new Set(deps.projects.memberProjectIds(userId));
      if (user.role === "admin") {
        for (const id of deps.projects.teamProjectIds()) ids.add(id);
      }
      return [...ids];
    },
  };
}
