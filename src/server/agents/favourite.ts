// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agent a new chat starts on: the user's favourite, else the default
// an admin marked, else the first created. Deleting an agent clears the
// favourites that named it, so the default answers with no write here.

import type {
  FavouriteAgentResponse,
  SetFavouriteAgentRequest,
} from "../../shared/api/agents.ts";
import { fields, jsonBody } from "../lib/body.ts";
import { BadRequest, Unauthorized } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import type { AgentStore } from "./store.ts";

export type FavouritePort = {
  byId(id: string): { agentId: string | null } | null;
  setAgent(id: string, agentId: string | null): void;
};

// the user's own pick, null when they follow the default
export function pickOf(users: FavouritePort, userId: string): string | null {
  return users.byId(userId)?.agentId ?? null;
}

export function favouriteOf(
  store: AgentStore,
  users: FavouritePort,
  userId: string,
): string | null {
  return pickOf(users, userId) ?? store.defaultId();
}

function parseFavourite(body: unknown): SetFavouriteAgentRequest {
  const b = fields(body, ["agentId"]);
  if (
    b.agentId !== null &&
    (typeof b.agentId !== "string" || b.agentId === "")
  ) {
    throw new BadRequest("agentId must be an id or null");
  }
  return { agentId: b.agentId };
}

export function favouriteRoutes(deps: {
  store: AgentStore;
  users: FavouritePort;
}): RouteDescriptor[] {
  const answer = (userId: string): FavouriteAgentResponse => ({
    agentId: pickOf(deps.users, userId),
    defaultId: deps.store.defaultId(),
    agents: deps.store
      .list()
      .map(({ id, name, avatar }) => ({ id, name, avatar })),
  });
  return [
    {
      method: "GET",
      path: "/api/profile/agent",
      policy: "authenticated",
      handle(_req, ctx) {
        return json(answer(ctx.principal!.userId));
      },
    },
    {
      method: "PUT",
      path: "/api/profile/agent",
      policy: "authenticated",
      async handle(req, ctx) {
        const { agentId } = parseFavourite(await jsonBody(req));
        const userId = ctx.principal!.userId;
        if (agentId !== null && deps.store.byId(agentId) === null) {
          throw new BadRequest("no such agent");
        }
        if (deps.users.byId(userId) === null)
          throw new Unauthorized("signed out");
        deps.users.setAgent(userId, agentId);
        return json(answer(userId));
      },
    },
  ];
}
