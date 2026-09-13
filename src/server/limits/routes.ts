// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { LimitsResponse } from "../../shared/api/limits.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import type { Limits } from "./defaults.ts";
import { parseLimits } from "./parse.ts";

export type RoutesDeps = {
  clock: Clock;
  response(): LimitsResponse;
  set(values: Limits, now: number): void;
  reset(): void;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/limits",
      policy: "admin",
      handle() {
        return json(deps.response());
      },
    },
    {
      method: "PUT",
      path: "/api/limits",
      policy: "admin",
      async handle(req) {
        const { values } = parseLimits(await jsonBody(req));
        deps.set(values, deps.clock());
        return json(deps.response());
      },
    },
    {
      method: "DELETE",
      path: "/api/limits",
      policy: "admin",
      handle() {
        deps.reset();
        return new Response(null, { status: 204 });
      },
    },
  ];
}
