// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Admin user management. Identity conflicts are checked in the same
// transaction as each write so the response names the field instead of
// exposing a unique-index error.

import type { UserResponse, UsersResponse } from "../../shared/api/users.ts";
import type { Role } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { Conflict, NotFound } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import {
  account,
  hashPassword,
  type UserFields,
  type UserRow,
} from "../users/index.ts";
import { parseNewUser, parseUserPassword, parseUserPatch } from "./parse.ts";
import type { LoginStore } from "./store.ts";

export type UsersPort = {
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
};

export type UsersRoutesDeps = {
  db: Db;
  logins: LoginStore;
  users: UsersPort;
  clock: Clock;
};

export function usersRoutes(deps: UsersRoutesDeps): RouteDescriptor[] {
  const find = (id: string): UserRow => {
    const user = deps.users.byId(id);
    if (user === null) throw new NotFound("no such user");
    return user;
  };
  const usernameAvailable = (username: string, except: string | null) => {
    const other = deps.users.byUsername(username);
    if (other !== null && other.id !== except) {
      throw new Conflict("username is taken");
    }
  };
  const emailAvailable = (email: string, except: string | null) => {
    const other = deps.users.byEmail(email);
    if (other !== null && other.id !== except) {
      throw new Conflict("email is taken");
    }
  };
  return [
    {
      method: "GET",
      path: "/api/users",
      policy: "admin",
      handle() {
        const body: UsersResponse = {
          users: deps.users.list().map(account),
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/users",
      policy: "admin",
      async handle(req) {
        const parsed = parseNewUser(await jsonBody(req));
        const passwordHash = await hashPassword(parsed.password);
        const user = transact(deps.db, () => {
          usernameAvailable(parsed.username, null);
          emailAvailable(parsed.email, null);
          return {
            result: deps.users.createUser({
              username: parsed.username,
              fullName: parsed.fullName,
              email: parsed.email,
              role: parsed.role,
              passwordHash,
              mustChangePassword: true,
              now: deps.clock(),
            }),
          };
        });
        const body: UserResponse = { user: account(user) };
        return json(body, 201);
      },
    },
    {
      method: "PATCH",
      path: "/api/users/:id",
      policy: "admin",
      async handle(req, ctx) {
        const patch = parseUserPatch(await jsonBody(req));
        const id = ctx.params.id;
        const changed = transact(deps.db, () => {
          const user = find(id);
          if (
            patch.username !== undefined &&
            patch.username !== user.username
          ) {
            usernameAvailable(patch.username, user.id);
            deps.users.setUsername(user.id, patch.username);
          }
          if (patch.email !== undefined && patch.email !== user.email) {
            emailAvailable(patch.email, user.id);
            deps.users.setEmail(user.id, patch.email);
          }
          if (
            patch.fullName !== undefined &&
            patch.fullName !== user.fullName
          ) {
            deps.users.setDetails(user.id, {
              fullName: patch.fullName,
              about: user.about,
            });
          }
          const roleChanged =
            patch.role !== undefined && patch.role !== user.role;
          const disabledChanged =
            patch.disabled !== undefined && patch.disabled !== user.disabled;
          if (roleChanged && user.id === ctx.principal!.userId) {
            throw new Conflict("cannot change your own role");
          }
          if (disabledChanged && user.id === ctx.principal!.userId) {
            throw new Conflict("cannot disable your own account");
          }
          const removesEnabledAdmin =
            user.role === "admin" &&
            !user.disabled &&
            ((roleChanged && patch.role === "member") ||
              (disabledChanged && patch.disabled === true));
          if (removesEnabledAdmin && deps.users.countAdmins() === 1) {
            throw new Conflict("the last admin must remain enabled");
          }
          if (roleChanged) deps.users.setRole(user.id, patch.role!);
          if (disabledChanged) {
            deps.users.setDisabled(user.id, patch.disabled!);
            if (patch.disabled === true) {
              deps.logins.deleteForUser(user.id);
            }
          }
          return {
            result: find(user.id),
            events: [
              ...(roleChanged
                ? [
                    {
                      type: "access.changed" as const,
                      data: { userIds: [user.id] },
                    },
                  ]
                : []),
              ...(disabledChanged && patch.disabled === true
                ? [
                    {
                      type: "login.revoked" as const,
                      data: { userId: user.id, loginId: null },
                    },
                  ]
                : []),
            ],
          };
        });
        const body: UserResponse = { user: account(changed) };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/users/:id/password",
      policy: "admin",
      async handle(req, ctx) {
        const { password } = parseUserPassword(await jsonBody(req));
        const id = ctx.params.id;
        if (id === ctx.principal!.userId) {
          throw new Conflict("cannot reset your own password");
        }
        const passwordHash = await hashPassword(password);
        transact(deps.db, () => {
          const user = find(id);
          deps.users.setPasswordHash(user.id, passwordHash);
          deps.users.setMustChangePassword(user.id, true);
          deps.logins.deleteForUser(user.id);
          return {
            result: undefined,
            events: [
              {
                type: "login.revoked" as const,
                data: { userId: user.id, loginId: null },
              },
            ],
          };
        });
        return new Response(null, { status: 204 });
      },
    },
  ];
}
