// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  AccessKeysResponse,
  CreateAccessKeyResponse,
} from "../../shared/api/profile.ts";
import type { UserAccessKeysResponse } from "../../shared/api/users.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { Conflict, Forbidden, NotFound, Unauthorized } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import type { UserRow } from "../users/index.ts";
import type { Auth } from "./auth.ts";
import {
  type AccessKeyStore,
  accessKeyOf,
  logRevokedKeys,
} from "./key-store.ts";
import { parseAccessKey } from "./parse.ts";
import type { LoginStore } from "./store.ts";

export type KeyRoutesDeps = {
  db: Db;
  keys: AccessKeyStore;
  logins: LoginStore;
  users: { byId(id: string): UserRow | null };
  auth: Pick<Auth, "project">;
  accessKeysPerUser(): number;
  clock: Clock;
  log: Log;
};

export function keyRoutes(deps: KeyRoutesDeps): RouteDescriptor[] {
  const user = (id: string) => {
    const found = deps.users.byId(id);
    if (found === null) throw new NotFound("no such user");
    return found;
  };
  const revoke = (userId: string, keyId: string) => {
    const found = transact(deps.db, () => {
      const owner = user(userId);
      const key = deps.keys.delete(userId, keyId);
      if (key === null) throw new NotFound("no such access key");
      return { result: { owner, key } };
    });
    logRevokedKeys(deps.log, found.owner.username, [found.key]);
    return new Response(null, { status: 204 });
  };
  return [
    {
      method: "GET",
      path: "/api/profile/keys",
      policy: "authenticated",
      handle(_req, ctx) {
        const body: AccessKeysResponse = {
          keys: deps.keys.list(ctx.principal!.userId).map(accessKeyOf),
          limit: deps.accessKeysPerUser(),
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/profile/keys",
      policy: "authenticated",
      async handle(req, ctx) {
        const parsed = parseAccessKey(await jsonBody(req));
        const principal = ctx.principal!;
        const made = transact(deps.db, () => {
          // A reset while the body arrived must not mint a new credential.
          const login =
            principal.via.kind === "login"
              ? deps.logins.byId(principal.via.id)
              : null;
          if (
            login === null ||
            login.userId !== principal.userId ||
            login.expiresAt <= deps.clock()
          ) {
            throw new Unauthorized();
          }
          const owner = user(principal.userId);
          if (owner.disabled) throw new Forbidden();
          if (owner.mustChangePassword) {
            throw new Forbidden("change your password first");
          }
          const keys = deps.keys.list(owner.id);
          if (keys.some((key) => key.name === parsed.name)) {
            throw new Conflict("access key name is taken");
          }
          const cap = deps.accessKeysPerUser();
          if (cap === 0) throw new Conflict("access keys are off");
          if (keys.length >= cap) {
            throw new Conflict("access key limit reached");
          }
          for (const id of parsed.projectIds ?? []) {
            deps.auth.project(principal, id);
          }
          return {
            result: {
              ...deps.keys.create(owner.id, parsed, deps.clock()),
              owner,
            },
          };
        });
        deps.log.info("access key created", {
          user: made.owner.username,
          key: made.key.id,
          scope: made.key.scope,
        });
        const body: CreateAccessKeyResponse = {
          key: accessKeyOf(made.key),
          token: made.token,
        };
        return json(body, 201);
      },
    },
    {
      method: "DELETE",
      path: "/api/profile/keys/:id",
      policy: "authenticated",
      handle: (_req, ctx) => revoke(ctx.principal!.userId, ctx.params.id),
    },
    {
      method: "GET",
      path: "/api/users/:id/keys",
      policy: "admin",
      handle(_req, ctx) {
        const body: UserAccessKeysResponse = {
          keys: deps.keys.list(user(ctx.params.id).id).map(accessKeyOf),
        };
        return json(body);
      },
    },
    {
      method: "DELETE",
      path: "/api/users/:id/keys/:keyId",
      policy: "admin",
      handle: (_req, ctx) => revoke(ctx.params.id, ctx.params.keyId),
    },
  ];
}
