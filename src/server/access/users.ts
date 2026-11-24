// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Admin user management. Identity conflicts are checked in the same
// transaction as each write so the response names the field instead of
// exposing a unique-index error. With email on, an admin sends an
// invite that opens the user's first login. A write that awaits a body
// reads the acting admin again in its transaction.

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
import type { Log } from "../lib/log.ts";
import { lastDays } from "../usage/index.ts";
import {
  account,
  isPlaceholderEmail,
  type UserFields,
  type UserRow,
} from "../users/index.ts";
import { actingWrite } from "./acting.ts";
import type { AdminKeys } from "./admin-keys.ts";
import {
  type AccessKeyRow,
  type AccessKeyStore,
  logRevokedKeys,
} from "./key-store.ts";
import type { Links } from "./links.ts";
import { parseNewUser, parseUserPatch } from "./parse.ts";
import type { PasskeyStore } from "./passkeys/store.ts";
import type { LoginStore } from "./store.ts";
import type { TaskClaimsPort } from "./task-claims.ts";
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
  keys: AccessKeyStore;
  taskClaims: TaskClaimsPort;
  log: Log;
  visits: VisitStore;
  users: UsersPort;
  projects: UsersProjectsPort;
  usage: UsersUsagePort;
  adminKeys: Pick<AdminKeys, "digestOf">;
  clock: Clock;
  // a placeholder address is shown only while email is on
  email: { enabled(): boolean };
  links: Pick<Links, "invite" | "revoke">;
  passkeys: Pick<PasskeyStore, "deleteForUser">;
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
  // an invite again, to another user who has never signed in
  const sendInvite = (id: string, adminId: string): void => {
    if (!deps.email.enabled()) throw new Conflict(NO_EMAIL);
    if (id === adminId) throw new Conflict("cannot invite yourself");
    transact(deps.db, () => {
      const user = find(id);
      if (user.disabled) throw new Conflict("the user is disabled");
      if (user.emailPlaceholder) throw new Conflict(PLACEHOLDER);
      if (user.signedInAt !== null) {
        throw new Conflict("the user has signed in already");
      }
      return {
        result: undefined,
        events: deps.links.invite(user.id, adminId),
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
        const user = actingWrite(deps, ctx.principal!, "admin", () => {
          usernameAvailable(parsed.username, null);
          emailAvailable(parsed.email, null);
          const created = deps.users.createUser({
            username: parsed.username,
            fullName: parsed.fullName,
            email: parsed.email,
            role: parsed.role,
            tz: parsed.tz,
            about: parsed.about,
            disabled: parsed.disabled,
            now: deps.clock(),
          });
          return {
            result: find(created.id),
            events: invite
              ? deps.links.invite(created.id, ctx.principal!.userId)
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
        const changed = actingWrite(deps, ctx.principal!, "admin", () => {
          const user = find(id);
          let revokedKeys: AccessKeyRow[] = [];
          // a key login's file follows the username, and only an admin
          // signs in by key, so a rename or a demote ends them at once
          let endedLogins: string[] = [];
          if (
            patch.username !== undefined &&
            patch.username !== user.username
          ) {
            usernameAvailable(patch.username, user.id);
            deps.users.setUsername(user.id, patch.username);
            endedLogins = deps.logins.deleteKeyLogins(user.id);
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
          if (roleChanged && patch.role === "member") {
            endedLogins = [
              ...endedLogins,
              ...deps.logins.deleteKeyLogins(user.id),
            ];
          }
          if (disabledChanged) {
            deps.users.setDisabled(user.id, patch.disabled!);
            if (patch.disabled === true) {
              deps.logins.deleteForUser(user.id);
              revokedKeys = deps.keys.deleteForUser(user.id);
              deps.links.revoke(user.id);
              deps.passkeys.deleteForUser(user.id);
            }
          }
          let lostProjects: string[] = [];
          if (roleChanged && user.role === "admin") {
            const memberOf = new Set(deps.projects.memberProjectIds(user.id));
            lostProjects = deps.projects
              .teamProjectIds()
              .filter((id) => !memberOf.has(id));
          }
          return {
            result: { user: find(user.id), revokedKeys },
            events: [
              ...(roleChanged ? [accessChanged([user.id])] : []),
              ...endedLogins.map((loginId) => loginRevoked(user.id, loginId)),
              ...(disabledChanged && patch.disabled === true
                ? [loginRevoked(user.id, null)]
                : []),
              ...deps.taskClaims.endForKeys(revokedKeys.map((key) => key.id)),
              ...deps.taskClaims.endForUser(user.id, lostProjects),
            ],
          };
        });
        logRevokedKeys(deps.log, changed.user.username, changed.revokedKeys);
        const body: UserResponse = { user: oneUser(changed.user) };
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
      // every way in the user holds ends: logins, live links, passkeys
      // and access keys, the passkeys and keys since a stolen login can
      // add one
      method: "POST",
      path: "/api/users/:id/sign-out",
      policy: "admin",
      handle(_req, ctx) {
        const id = ctx.params.id;
        if (id === ctx.principal!.userId) {
          throw new Conflict("cannot sign yourself out everywhere");
        }
        const ended = actingWrite(deps, ctx.principal!, "admin", () => {
          const user = find(id);
          deps.logins.deleteForUser(user.id);
          const revokedKeys = deps.keys.deleteForUser(user.id);
          deps.links.revoke(user.id);
          deps.passkeys.deleteForUser(user.id);
          return {
            result: { user, revokedKeys },
            events: [
              loginRevoked(user.id, null),
              ...deps.taskClaims.endForKeys(revokedKeys.map((key) => key.id)),
            ],
          };
        });
        logRevokedKeys(deps.log, ended.user.username, ended.revokedKeys);
        deps.log.info("signed out everywhere", { user: ended.user.username });
        return new Response(null, { status: 204 });
      },
    },
    {
      // sent again: the last invite stops working
      method: "POST",
      path: "/api/users/:id/invite",
      policy: "admin",
      handle(_req, ctx) {
        sendInvite(ctx.params.id, ctx.principal!.userId);
        return new Response(null, { status: 204 });
      },
    },
  ];
}
