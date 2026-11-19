// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  SandboxLeasesResponse,
  SandboxResponse,
} from "../../shared/api/sandbox.ts";
import { SANDBOX_KEYS } from "../../shared/contracts/sandbox.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import { parseSandbox } from "./parse.ts";
import type { SandboxStore } from "./store.ts";

export type RoutesDeps = {
  store: SandboxStore;
  clock: Clock;
  log: Log;
  answer(): SandboxResponse;
  leases(): SandboxLeasesResponse;
  // after a save: the leases follow the settings
  saved(): void;
};

const KEY_FILES = Object.values(SANDBOX_KEYS)
  .map((name) => `${name}.key`)
  .join(", ");

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/admin/sandbox",
      policy: "admin",
      handle() {
        return json(deps.answer());
      },
    },
    {
      method: "PUT",
      path: "/api/admin/sandbox",
      policy: "admin",
      async handle(req) {
        const body = parseSandbox(await jsonBody(req));
        const held = deps.store.settings();
        const next = {
          shell: body.shell ?? held.shell,
          endpoint: body.endpoint === undefined ? held.endpoint : body.endpoint,
          image: body.image === undefined ? held.image : body.image,
          network: body.network ?? held.network,
          hosts: body.hosts === undefined ? held.hosts : body.hosts,
        };
        if (next.network === "hosts" && next.hosts?.length === 0) {
          throw new BadRequest("the hosts network needs a host at least");
        }
        if (next.shell === "sandbox") {
          if (next.endpoint === null) {
            throw new BadRequest("the sandbox shell needs a gateway endpoint");
          }
          if (Object.values(deps.answer().keys).includes(false)) {
            throw new BadRequest(`the sandbox shell needs ${KEY_FILES}`);
          }
        }
        deps.store.save(next, deps.clock());
        deps.log.info("sandbox settings saved", {
          shell: next.shell,
          network: next.network,
        });
        deps.saved();
        return json(deps.answer());
      },
    },
    {
      method: "GET",
      path: "/api/admin/sandbox/leases",
      policy: "admin",
      handle() {
        return json(deps.leases());
      },
    },
  ];
}
