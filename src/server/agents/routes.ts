// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agents, all for admins. A save names a provider and a model; the
// model must be in that provider's catalog, and what the catalog says
// about it is kept on the row so a list never asks again.

import type {
  AgentImpactResponse,
  AgentResponse,
  AgentsResponse,
} from "../../shared/api/agents.ts";
import type {
  ProjectAgentsResponse,
  SwitchableServer,
  SwitchableSkill,
} from "../../shared/api/sessions.ts";
import type { AgentServer } from "../../shared/contracts/mcp.ts";
import type {
  CatalogMatch,
  Endpoint,
} from "../../shared/contracts/provider.ts";
import { fixedThinking } from "../../shared/thinking.ts";
import { EFFORTS, isEffort } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import type { ProjectRow } from "../projects/index.ts";
import type { ProviderRow } from "../providers/index.ts";
import { type ParsedAgent, parseAgent } from "./parse.ts";
import { type PicksPort, startingOf } from "./starting.ts";
import { type AgentFields, type AgentStore, summary } from "./store.ts";

export type ProvidersPort = {
  byId(id: string): ProviderRow | null;
  model(provider: ProviderRow, id: string): Promise<CatalogMatch | null>;
  endpoints(provider: ProviderRow, model: string): Promise<Endpoint[]>;
};

export type AccessPort = {
  project(principal: Principal, id: string): ProjectRow;
};

// what an agent's delete does to the areas built after agents, each
// reached through a thunk the compose root passes: the writes run in
// the delete's transaction and answer their envelopes
export type SessionsPort = {
  agentImpact(agentId: string): { chats: number; running: number };
  archiveAgent(agentId: string, now: number): BusEvent[];
};

export type AutomationsPort = {
  store: { activeOn(agentId: string): string[] };
  scheduler: { wake(): void };
  suspendAgent(agentId: string, by: string, now: number): BusEvent[];
};

export type RunnerPort = {
  stopAgent(agentId: string): void;
};

export type SkillsPort = {
  exists(id: string): boolean;
  assign(agentId: string, ids: string[]): void;
  switchable(): Record<string, SwitchableSkill[]>;
};

export type McpPort = {
  setAgentServers(agentId: string, rows: AgentServer[]): void;
  switchableBy(
    agents: { id: string; servers: AgentServer[] }[],
  ): Record<string, SwitchableServer[]>;
};

export type CapabilitiesPort = {
  capabilities(): string[];
};

// the credentials bound to a project, in name order
export type CredentialsPort = {
  forProject(projectId: string): { id: string; name: string }[];
};

export type RoutesDeps = {
  db: Db;
  store: AgentStore;
  providers: ProvidersPort;
  skills: SkillsPort;
  mcp: McpPort;
  tools: CapabilitiesPort;
  credentials: CredentialsPort;
  access: AccessPort;
  sessions: () => SessionsPort;
  automations: () => AutomationsPort;
  runner: () => RunnerPort;
  users: PicksPort & { clearAgent(agentId: string): void };
  clock: Clock;
};

// a catalog that describes the model is never overridden; one that
// lists only ids takes the admin's window and tools flag, and a model
// with tools needs a window, since the tool loop weighs it before calls
function stated(
  model: CatalogMatch,
  body: ParsedAgent["stated"],
): CatalogMatch {
  if (model.described) {
    if (body !== null) {
      throw new BadRequest(
        "contextLength and tools are only for a model the catalog does not describe",
      );
    }
    return model;
  }
  const tools = body?.tools ?? false;
  const contextLength = body?.contextLength ?? null;
  if (tools && contextLength === null) {
    throw new BadRequest("contextLength is required for a model with tools");
  }
  return { ...model, contextLength, tools };
}

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  // the rows the body names are checked before the catalog fetch and
  // again in the transaction, since the world may move while it waits
  const check = (body: ParsedAgent, except: string | null) => {
    const other = deps.store.byName(body.name);
    if (other && other.id !== except) {
      throw new Conflict(`an agent named ${body.name} exists`);
    }
    const provider = deps.providers.byId(body.providerId);
    if (!provider) throw new BadRequest("no such provider");
    for (const id of body.skills) {
      if (!deps.skills.exists(id)) throw new BadRequest(`no such skill ${id}`);
    }
    if (body.upstream !== null && provider.wire !== "openrouter") {
      throw new BadRequest("upstream is only for an OpenRouter provider");
    }
    const effort = body.effort;
    if (effort !== null && !isEffort(provider.wire, effort)) {
      throw new BadRequest(
        `effort must be one of ${EFFORTS[provider.wire].join(", ")}`,
      );
    }
    return { provider, effort };
  };
  const resolve = async (
    req: Request,
    except: string | null,
  ): Promise<() => AgentFields & { mark: boolean | null }> => {
    const body = parseAgent(await jsonBody(req));
    const checked = check(body, except);
    const model = await deps.providers.model(checked.provider, body.model);
    // checked as the model is, when it is chosen; a tag that goes later
    // is skipped by OpenRouter and costs only the preference, so a save
    // that keeps the model and the tag never asks again
    const before = except === null ? null : deps.store.byId(except);
    const kept =
      before !== null &&
      before.providerId === checked.provider.id &&
      before.model.id === body.model &&
      before.upstream === body.upstream;
    const endpoints =
      body.upstream === null || model === null || kept
        ? null
        : await deps.providers.endpoints(checked.provider, body.model);
    // called by the handler right before its write, with no await between
    return () => {
      const { provider, effort } = check(body, except);
      if (!model) {
        throw new BadRequest(`${provider.name} does not list ${body.model}`);
      }
      if (
        endpoints !== null &&
        !endpoints.some((e) => e.tag === body.upstream)
      ) {
        throw new BadRequest(
          `upstream ${body.upstream} does not serve ${body.model} on ${provider.name}`,
        );
      }
      const resolved = stated(model, body.stated);
      return {
        name: body.name,
        avatar: body.avatar,
        providerId: provider.id,
        model: resolved,
        // the catalog decides for a model that always or never thinks: a
        // word saved before it said so, or sent by provisioning, is dropped
        thinking: fixedThinking(resolved) === null ? body.thinking : null,
        effort,
        prompt: body.prompt,
        skills: body.skills,
        servers: body.servers,
        mcpMode: body.mcpMode,
        upstream: body.upstream,
        mark: body.mark,
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
        const agent = transact(deps.db, () => {
          const values = fields();
          const created = deps.store.create({ ...values, now: deps.clock() });
          if (values.mark === true) deps.store.setDefault(created.id, true);
          deps.skills.assign(created.id, values.skills);
          deps.mcp.setAgentServers(created.id, values.servers);
          return { result: deps.store.byId(created.id)! };
        });
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
        const updated = transact(deps.db, () => {
          const values = fields();
          const saved = deps.store.update(agent.id, values);
          if (!saved) throw new NotFound("no such agent");
          if (values.mark !== null)
            deps.store.setDefault(agent.id, values.mark);
          deps.skills.assign(agent.id, values.skills);
          deps.mcp.setAgentServers(agent.id, values.servers);
          return { result: deps.store.byId(agent.id)! };
        });
        const body: AgentResponse = { agent: summary(updated) };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/agents/:id/impact",
      policy: "admin",
      handle(_req, ctx) {
        const agent = find(ctx.params.id);
        const { chats, running } = deps.sessions().agentImpact(agent.id);
        const automations = deps.automations().store.activeOn(agent.id);
        const body: AgentImpactResponse = {
          chats,
          automations: automations.length,
          running,
        };
        return json(body);
      },
    },
    {
      // retires the row, which frees its name, provider, skills and
      // servers; its chats are archived and its automations paused
      method: "DELETE",
      path: "/api/agents/:id",
      policy: "admin",
      handle(_req, ctx) {
        const by = ctx.principal!.userId;
        const agent = find(ctx.params.id);
        transact(deps.db, () => {
          const now = deps.clock();
          if (!deps.store.retire(agent.id, now)) {
            throw new NotFound("no such agent");
          }
          deps.skills.assign(agent.id, []);
          deps.mcp.setAgentServers(agent.id, []);
          deps.users.clearAgent(agent.id);
          return {
            result: undefined,
            events: [
              ...deps.sessions().archiveAgent(agent.id, now),
              ...deps.automations().suspendAgent(agent.id, by, now),
            ],
          };
        });
        deps.automations().scheduler.wake();
        // an archived chat still running ends as a stop does
        deps.runner().stopAgent(agent.id);
        return json({});
      },
    },
    {
      // the agents the composer offers in a project: every agent, until
      // agents are members of projects
      method: "GET",
      path: "/api/projects/:id/agents",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const agents = deps.store.list().map(summary);
        const body: ProjectAgentsResponse = {
          agents,
          startsOn: startingOf(deps.store, deps.users, ctx.principal!.userId),
          capabilities: deps.tools.capabilities(),
          servers: deps.mcp.switchableBy(agents),
          skills: deps.skills.switchable(),
          credentials: deps.credentials
            .forProject(project.id)
            .map(({ id, name }) => ({ id, name })),
        };
        return json(body);
      },
    },
  ];
}
