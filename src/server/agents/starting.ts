// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agent a new chat starts on: the one the user last picked in the
// composer, else the default an admin marked, else the first created.
// Deleting an agent clears the picks that named it, so the default
// answers with no write here.

import type {
  PickAgentRequest,
  PickAgentResponse,
} from "../../shared/api/agents.ts";
import { fields, jsonBody } from "../lib/body.ts";
import { BadRequest, Unauthorized } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import type { AgentStore } from "./store.ts";

export type PicksPort = {
  byId(id: string): { agentId: string | null } | null;
  setAgent(id: string, agentId: string | null): void;
};

export function startingOf(
  store: AgentStore,
  users: PicksPort,
  userId: string,
): string | null {
  return users.byId(userId)?.agentId ?? store.defaultId();
}

function parsePick(body: unknown): PickAgentRequest {
  const b = fields(body, ["agentId"]);
  if (typeof b.agentId !== "string" || b.agentId === "") {
    throw new BadRequest("agentId must be an id");
  }
  return { agentId: b.agentId };
}

export function startingRoutes(deps: {
  store: AgentStore;
  users: PicksPort;
}): RouteDescriptor[] {
  return [
    {
      // the composer's pick, kept as the user's own start
      method: "PUT",
      path: "/api/profile/agent",
      policy: "authenticated",
      async handle(req, ctx) {
        const { agentId } = parsePick(await jsonBody(req));
        const userId = ctx.principal!.userId;
        if (deps.store.byId(agentId) === null) {
          throw new BadRequest("no such agent");
        }
        if (deps.users.byId(userId) === null) {
          throw new Unauthorized("signed out");
        }
        deps.users.setAgent(userId, agentId);
        const body: PickAgentResponse = {
          agentId: startingOf(deps.store, deps.users, userId),
        };
        return json(body);
      },
    },
  ];
}
