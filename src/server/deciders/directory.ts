// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  DirectoryDeciderDaysResponse,
  DirectoryDeciderResponse,
  DirectoryDecidersResponse,
} from "../../shared/api/directory.ts";
import type { DecisionId } from "../../shared/contracts/decision.ts";
import { parseName, parseNoQuery } from "../lib/body.ts";
import { NotFound } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { parseZoneQuery } from "../usage/index.ts";
import type { ProvidersPort } from "./decide.ts";
import { type DecisionStore, deciderIdFor } from "./decisions.ts";
import type { DeciderStore } from "./store.ts";

// a decider's days in every project, the usage area's answer
export type DaysPort = {
  deciderDays(
    deciderId: string,
    timeZone: string,
  ): DirectoryDeciderDaysResponse;
};

export type DirectoryDeps = {
  store: DeciderStore;
  decisions: DecisionStore;
  providers: Pick<ProvidersPort, "byId">;
  usage: DaysPort;
};

export function directoryRoutes(deps: DirectoryDeps): RouteDescriptor[] {
  const answered = (deciderId: string): DecisionId[] => {
    const defaultId = deps.store.defaultId();
    return deps.decisions
      .list()
      .filter((d) => deciderIdFor(d, defaultId) === deciderId)
      .map((d) => d.id);
  };
  const find = (name: unknown) => {
    const decider = deps.store.byName(parseName(name));
    if (decider === null) throw new NotFound("no such decider");
    return decider;
  };
  return [
    {
      method: "GET",
      path: "/api/directory/deciders",
      policy: "authenticated",
      handle(_req, ctx) {
        parseNoQuery(ctx.url);
        const body: DirectoryDecidersResponse = {
          deciders: deps.store
            .list()
            .map((decider) => ({
              id: decider.id,
              name: decider.name,
              default: decider.default,
              model: decider.model,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/directory/deciders/:name",
      policy: "authenticated",
      handle(_req, ctx) {
        const { providerId, ...decider } = find(ctx.params.name);
        const body: DirectoryDeciderResponse = {
          decider,
          provider: deps.providers.byId(providerId)?.name ?? "",
          decisions: answered(decider.id),
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/directory/deciders/:name/days",
      policy: "authenticated",
      handle(_req, ctx) {
        const decider = find(ctx.params.name);
        const timeZone = parseZoneQuery(ctx.url);
        return json(deps.usage.deciderDays(decider.id, timeZone));
      },
    },
  ];
}
