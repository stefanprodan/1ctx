// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agents, all for admins. A save names a provider and a model; the
// model must be in that provider's catalog, and what the catalog says
// about it is kept on the row so a list never asks again.

import type { AgentResponse, AgentsResponse } from "../../shared/api/agents.ts";
import type {
  ProjectAgentsResponse,
  SwitchableServer,
  SwitchableSkill,
} from "../../shared/api/sessions.ts";
import type { AgentServer } from "../../shared/contracts/mcp.ts";
import type { CatalogMatch } from "../../shared/contracts/provider.ts";
import { fixedThinking } from "../../shared/thinking.ts";
import { EFFORTS, isEffort } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import type { ProjectRow } from "../projects/index.ts";
import type { ProviderRow } from "../providers/index.ts";
import { type ParsedAgent, parseAgent } from "./parse.ts";
import { type AgentFields, type AgentStore, summary } from "./store.ts";

export type ProvidersPort = {
  byId(id: string): ProviderRow | null;
  model(provider: ProviderRow, id: string): Promise<CatalogMatch | null>;
};

export type AccessPort = {
  project(principal: Principal, id: string): ProjectRow;
};

// whether a session runs on the agent: a closure, since sessions are
// built after agents
export type SessionsPort = {
  usesAgent(agentId: string): boolean;
};

export type AutomationsPort = {
  usesAgent(agentId: string): boolean;
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
  sessions: SessionsPort;
  automations: AutomationsPort;
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
  ): Promise<() => AgentFields> => {
    const body = parseAgent(await jsonBody(req));
    const checked = check(body, except);
    const model = await deps.providers.model(checked.provider, body.model);
    // called by the handler right before its write, with no await between
    return () => {
      const { provider, effort } = check(body, except);
      if (!model) {
        throw new BadRequest(`${provider.name} does not list ${body.model}`);
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
          deps.skills.assign(agent.id, values.skills);
          deps.mcp.setAgentServers(agent.id, values.servers);
          return { result: deps.store.byId(agent.id)! };
        });
        const body: AgentResponse = { agent: summary(updated) };
        return json(body);
      },
    },
    {
      method: "DELETE",
      path: "/api/agents/:id",
      policy: "admin",
      handle(_req, ctx) {
        const agent = find(ctx.params.id);
        if (deps.sessions.usesAgent(agent.id)) {
          throw new Conflict(`a chat uses ${agent.name}`);
        }
        if (deps.automations.usesAgent(agent.id)) {
          throw new Conflict(`an automation uses ${agent.name}`);
        }
        deps.store.delete(agent.id);
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
