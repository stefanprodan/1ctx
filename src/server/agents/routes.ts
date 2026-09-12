// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agents, all for admins. A save names a provider and a model; the
// model must be in that provider's catalog, and what the catalog says
// about it is kept on the row so a list never asks again.

import type {
  AgentResponse,
  AgentsResponse,
  SaveAgentRequest,
} from "../../shared/api/agents.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { BadGateway, BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import {
  CatalogError,
  type Catalogs,
  type ProviderStore,
} from "../providers/index.ts";
import { parseAgent } from "./parse.ts";
import { type AgentFields, type AgentStore, summary } from "./store.ts";

export type RoutesDeps = {
  store: AgentStore;
  providers: ProviderStore;
  catalogs: Catalogs;
  clock: Clock;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  // the body checked against the world: the provider is there, the
  // catalog lists the model, and no other agent has the name
  // the rows the body names, as they are right now: run before the
  // catalog is asked, so a bad body costs no fetch, and again in the
  // same turn as the write, since the world may have moved while the
  // catalog answered
  const check = (body: SaveAgentRequest, except: string | null) => {
    const other = deps.store.byName(body.name);
    if (other && other.id !== except) {
      throw new Conflict(`an agent named ${body.name} exists`);
    }
    const provider = deps.providers.byId(body.providerId);
    if (!provider) throw new BadRequest("no such provider");
    return provider;
  };
  const resolve = async (
    req: Request,
    except: string | null,
  ): Promise<() => AgentFields> => {
    const body = parseAgent(await jsonBody(req));
    let model: Awaited<ReturnType<Catalogs["model"]>>;
    try {
      model = await deps.catalogs.model(check(body, except), body.model);
    } catch (err) {
      if (err instanceof CatalogError) throw new BadGateway(err.message);
      throw err;
    }
    // called by the handler right before its write, with no await between
    return () => {
      const provider = check(body, except);
      if (!model) {
        throw new BadRequest(`${provider.name} does not list ${body.model}`);
      }
      return {
        name: body.name,
        avatar: body.avatar,
        providerId: provider.id,
        model,
        prompt: body.prompt,
      };
    };
  };
  const find = (id: string) => {
    const agent = deps.store.byId(id);
    if (!agent) throw new NotFound("no such agent");
    return agent;
  };
  return [
    {
      method: "GET",
      path: "/api/agents",
      policy: "admin",
      handle() {
        const body: AgentsResponse = { agents: deps.store.list().map(summary) };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/agents",
      policy: "admin",
      async handle(req) {
        const fields = await resolve(req, null);
        const agent = deps.store.create({ ...fields(), now: deps.clock() });
        const body: AgentResponse = { agent: summary(agent) };
        return json(body, 201);
      },
    },
    {
      method: "PATCH",
      path: "/api/agents/:id",
      policy: "admin",
      async handle(req, ctx) {
        const agent = find(ctx.params.id);
        const fields = await resolve(req, agent.id);
        // gone while the catalog was asked
        const updated = deps.store.update(agent.id, fields());
        if (!updated) throw new NotFound("no such agent");
        const body: AgentResponse = { agent: summary(updated) };
        return json(body);
      },
    },
    {
      method: "DELETE",
      path: "/api/agents/:id",
      policy: "admin",
      handle(_req, ctx) {
        deps.store.delete(find(ctx.params.id).id);
        return json({});
      },
    },
  ];
}
