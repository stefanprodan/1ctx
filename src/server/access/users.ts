// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Admin user management. Identity conflicts are checked in the same
// transaction as each write so the response names the field instead of
// exposing a unique-index error. With email on, an admin is offered an
// invite and a reset by link in place of typing a password.

import type { LinkPurpose } from "../../shared/api/access.ts";
import type { SendTotals } from "../../shared/api/admin.ts";
import type {
  AdminUser,
  UserResponse,
  UsersResponse,
} from "../../shared/api/users.ts";
import type { Role } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import { accessChanged, loginRevoked } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import { Conflict, NotFound } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { newToken } from "../lib/ids.ts";
import { lastDays } from "../usage/index.ts";
import {
  account,
  isPlaceholderEmail,
  type UserFields,
  type UserRow,
} from "../users/index.ts";
import type { Links } from "./links.ts";
import { parseNewUser, parseUserPassword, parseUserPatch } from "./parse.ts";
import type { LoginStore } from "./store.ts";
import type { VisitStore } from "./visits.ts";

export type UsersPort = {
  list(): UserRow[];
  byId(id: string): UserRow | null;
  byUsername(username: string): UserRow | null;
  byEmail(email: string): UserRow | null;
  setDetails(id: string, fields: { fullName: string; about: string }): void;
  setUsername(id: string, username: string): void;
  setEmail(id: string, email: string): void;
  setRole(id: string, role: Role): void;
  setTz(id: string, tz: string): void;
  setDisabled(id: string, disabled: boolean): void;
  setMustChangePassword(id: string, required: boolean): void;
  setPasswordHash(id: string, hash: string): void;
  hashPassword(password: string): Promise<string>;
  countAdmins(): number;
  createUser(fields: UserFields): UserRow;
};

export type UsersProjectsPort = {
  memberProjectIds(userId: string): string[];
  teamProjectIds(): string[];
  personal(userId: string): { id: string } | null;
};

export type UsersUsagePort = {
  projectTotal(projectId: string, since: number, until: number): SendTotals;
};

export type UsersRoutesDeps = {
  db: Db;
  logins: LoginStore;
  visits: VisitStore;
  users: UsersPort;
  projects: UsersProjectsPort;
  usage: UsersUsagePort;
  clock: Clock;
  // a placeholder address is shown only while email is on
  email: { enabled(): boolean };
  links: Pick<Links, "issue" | "revoke" | "notice">;
};

const NO_EMAIL = "email is not set up";
const PLACEHOLDER = "email is a placeholder, so no email reaches it";

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
  const teamIds = () => new Set(deps.projects.teamProjectIds());
  const adminUser = (
    user: UserRow,
    lastVisitDay: string | null,
    teams: Set<string>,
  ): AdminUser => ({
    ...account(user),
    lastVisitDay,
    projectIds: deps.projects
      .memberProjectIds(user.id)
      .filter((id) => teams.has(id)),
  });
  const oneUser = (user: UserRow): AdminUser =>
    adminUser(user, deps.visits.latestFor(user.id), teamIds());
  const emailAvailable = (email: string, except: string | null) => {
    const other = deps.users.byEmail(email);
    if (other !== null && other.id !== except) {
      throw new Conflict("email is taken");
    }
  };
  // a link emailed to another user who can take one
  const sendLink = (
    purpose: LinkPurpose,
    id: string,
    adminId: string,
  ): void => {
    if (!deps.email.enabled()) throw new Conflict(NO_EMAIL);
    if (id === adminId) {
      throw new Conflict(
        purpose === "invite"
          ? "cannot invite yourself"
          : "cannot reset your own password",
      );
    }
    transact(deps.db, () => {
      const user = find(id);
      if (user.disabled) throw new Conflict("the user is disabled");
      if (user.emailPlaceholder) throw new Conflict(PLACEHOLDER);
      // a user with a password of their own gets a reset, never a
      // 7-day link that sets one
      if (purpose === "invite" && !user.mustChangePassword) {
        throw new Conflict("the user has a password. Send a reset link");
      }
      return {
        result: undefined,
        events: deps.links.issue(purpose, user.id, adminId),
      };
    });
  };
  return [
    {
      method: "GET",
      path: "/api/users",
      policy: "admin",
      handle() {
        const visits = deps.visits.latest();
        const teams = teamIds();
        const body: UsersResponse = {
          emailOn: deps.email.enabled(),
          users: deps.users
            .list()
            .map((user) =>
              adminUser(user, visits.get(user.id)?.day ?? null, teams),
            ),
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/users",
      policy: "admin",
      async handle(req, ctx) {
        const parsed = parseNewUser(await jsonBody(req));
        const invite = parsed.invite === true;
        if (invite && !deps.email.enabled()) throw new Conflict(NO_EMAIL);
        if (invite && isPlaceholderEmail(parsed.email)) {
          throw new Conflict(PLACEHOLDER);
        }
        // an invited user's first password is one nobody knows, hashed
        // like any other, until the invite sets theirs
        const passwordHash = await deps.users.hashPassword(
          invite ? newToken() : parsed.password!,
        );
        const user = transact(deps.db, () => {
          usernameAvailable(parsed.username, null);
          emailAvailable(parsed.email, null);
          const created = deps.users.createUser({
            username: parsed.username,
            fullName: parsed.fullName,
            email: parsed.email,
            role: parsed.role,
            tz: parsed.tz,
            passwordHash,
            mustChangePassword: parsed.mustChangePassword ?? true,
            about: parsed.about,
            disabled: parsed.disabled,
            now: deps.clock(),
          });
          return {
            result: find(created.id),
            events: invite
              ? deps.links.issue("invite", created.id, ctx.principal!.userId)
              : [],
          };
        });
        const body: UserResponse = { user: oneUser(user) };
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
            // a link sent to the old address must not outlive it
            deps.links.revoke(user.id);
          }
          const fullName = patch.fullName ?? user.fullName;
          const about = patch.about ?? user.about;
          if (fullName !== user.fullName || about !== user.about) {
            deps.users.setDetails(user.id, {
              fullName,
              about,
            });
          }
          if (patch.tz !== undefined && patch.tz !== user.tz) {
            deps.users.setTz(user.id, patch.tz);
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
              deps.links.revoke(user.id);
            }
          }
          return {
            result: find(user.id),
            events: [
              ...(roleChanged ? [accessChanged([user.id])] : []),
              ...(disabledChanged && patch.disabled === true
                ? [loginRevoked(user.id, null)]
                : []),
            ],
          };
        });
        const body: UserResponse = { user: oneUser(changed) };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/users/:id/usage",
      policy: "admin",
      handle(_req, ctx) {
        const own = deps.projects.personal(find(ctx.params.id).id);
        return json(
          lastDays(deps.clock(), (since, until) =>
            own === null
              ? { sends: 0, tokens: 0, cost: 0 }
              : deps.usage.projectTotal(own.id, since, until),
          ),
        );
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
        const passwordHash = await deps.users.hashPassword(password);
        transact(deps.db, () => {
          const user = find(id);
          deps.users.setPasswordHash(user.id, passwordHash);
          deps.users.setMustChangePassword(user.id, true);
          deps.logins.deleteForUser(user.id);
          deps.links.revoke(user.id);
          return {
            result: undefined,
            events: [
              loginRevoked(user.id, null),
              ...deps.links.notice(user, "admin-reset", ctx.address),
            ],
          };
        });
        return new Response(null, { status: 204 });
      },
    },
    {
      method: "POST",
      path: "/api/users/:id/reset-link",
      policy: "admin",
      handle(_req, ctx) {
        sendLink("reset", ctx.params.id, ctx.principal!.userId);
        return new Response(null, { status: 204 });
      },
    },
    {
      // sent again: the last invite stops working
      method: "POST",
      path: "/api/users/:id/invite",
      policy: "admin",
      handle(_req, ctx) {
        sendLink("invite", ctx.params.id, ctx.principal!.userId);
        return new Response(null, { status: 204 });
      },
    },
  ];
}
