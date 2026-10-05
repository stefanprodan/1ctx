// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The deciders list and a decider's page, for every signed-in user, so
// a member can see what model judges a run and how often it is asked.
// A body names the provider and the decisions alone, never a provider
// id, a base URL, a key or a decision's text. Its days are the
// decider's answers in every project as one series, whoever asks.

import type {
  DirectoryDeciderDaysResponse,
  DirectoryDeciderResponse,
  DirectoryDecidersResponse,
} from "../../shared/api/directory.ts";
import type { DecisionId } from "../../shared/contracts/decision.ts";
import { NotFound } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { parseZoneQuery } from "../usage/index.ts";
import type { ProvidersPort } from "./decide.ts";
import type { DecisionStore } from "./decisions.ts";
import { parseDeciderName, parseNoQuery } from "./parse.ts";
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
  // the decisions each decider answers now, as decide() picks it: one
  // naming none asks the default, and a turned-off one asks nobody
  const answered = (): Map<string, DecisionId[]> => {
    const defaultId = deps.store.defaultId();
    const out = new Map<string, DecisionId[]>();
    for (const decision of deps.decisions.list()) {
      const id = decision.deciderId ?? defaultId;
      if (!decision.enabled || id === null) continue;
      out.set(id, [...(out.get(id) ?? []), decision.id]);
    }
    return out;
  };
  const find = (name: unknown) => {
    const decider = deps.store.byName(parseDeciderName(name));
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
        const decisions = answered();
        const body: DirectoryDecidersResponse = {
          deciders: deps.store
            .list()
            .map((decider) => ({
              id: decider.id,
              name: decider.name,
              default: decider.default,
              model: decider.model,
              decisions: decisions.get(decider.id) ?? [],
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
          decisions: answered().get(decider.id) ?? [],
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
