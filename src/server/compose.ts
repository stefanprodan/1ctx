// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The composition root: the areas in layer order, each built by its
// own factory with the capabilities of the areas it declared ports to,
// the complete route list, the router. main.ts calls it with the
// flags; the test helper calls it with a memory db and a fake clock,
// so a test exercises the wiring the binary runs.

import { MCP_KEY_PREFIX, type SecretKind } from "../shared/words.ts";
import { type Access, accessArea } from "./access/index.ts";
import { type AgentStore, type Agents, agentsArea } from "./agents/index.ts";
import { type Automations, automationsArea } from "./automations/index.ts";
import type { Db } from "./db/index.ts";
import type { Clock } from "./lib/clock.ts";
import type { RouteDescriptor } from "./lib/http.ts";
import type { Log } from "./lib/log.ts";
import { limitsArea } from "./limits/index.ts";
import { type Mcp, type McpServerStore, mcpArea } from "./mcp/index.ts";
import {
  type MemoryArea,
  type MemoryStore,
  memoryArea,
} from "./memory/index.ts";
import { type ProjectStore, projectsArea } from "./projects/index.ts";
import {
  type Catalogs,
  type Fetcher,
  type ProviderStore,
  type Providers,
  providersArea,
} from "./providers/index.ts";
import { type Provision, provisionArea } from "./provision/index.ts";
import { renderMarkdown } from "./render/index.ts";
import { type Registry, type Runner, runnerArea } from "./runner/index.ts";
import {
  type SessionStore,
  type Sessions,
  sessionsArea,
} from "./sessions/index.ts";
import { type SkillStore, type Skills, skillsArea } from "./skills/index.ts";
import { type Tools, toolsArea } from "./tools/index.ts";
import { type Usage, type UsageStore, usageArea } from "./usage/index.ts";
import { type UserStore, type Users, usersArea } from "./users/index.ts";
import { healthRoute } from "./web/health.ts";
import { type Router, router } from "./web/router.ts";
import { type Socket, socketArea } from "./web/socket.ts";

export type ComposeOptions = {
  db: Db;
  // the secrets port: the bare value or null
  secret: (kind: SecretKind, name: string) => string | null;
  // the names of the key files of a kind, for a form's pick;
  // absent when nothing lists them
  secretNames?: (kind: SecretKind) => string[];
  clock: Clock;
  // what reaches a provider; a test passes a fake
  fetcher?: Fetcher;
  log: (area: string) => Log;
  version: string;
  secureCookie: boolean;
  trustProxy: boolean;
  // a test seam for the runner's tool state machine
  tools?: Tools;
  // a test's registry with its own caps
  registry?: Registry;
  // Provisioning validates before bootstrap and never repairs or schedules.
  activate?: boolean;
};

export type App = {
  users: UserStore;
  projects: ProjectStore;
  providers: ProviderStore;
  mcp: McpServerStore;
  skills: SkillStore;
  agents: AgentStore;
  memory: MemoryStore;
  sessions: SessionStore;
  automations: Automations["store"];
  automationScheduler: Automations["scheduler"];
  usage: UsageStore;
  catalogs: Catalogs;
  chat: Providers["chat"];
  // the one way a user is made: with its personal project
  createUser: Users["createUser"];
  runner: Runner;
  socket: Socket;
  routes: RouteDescriptor[];
  handle: Router;
  provision: Provision;
  // drop expired logins; called at start and every hour
  sweep(): number;
  // the hourly MCP refresh loop; main.ts starts it after the first
  // sweep, a test only when it tests the pass
  mcpStart(): void;
  // terminate every send and close every socket, in that order
  shutdown(): Promise<void>;
};

export async function compose(options: ComposeOptions): Promise<App> {
  const { db, clock, secret } = options;
  // Ports that point down the list, at an area built after the one that
  // holds them, are closures called once the list is complete: a user
  // is made with its personal project, project routes read sessions and
  // usage built later, a provider an agent runs on and an agent a chat
  // runs on cannot go, a project route asks access what the principal
  // may see, and the session detail asks the runner for the reply in
  // flight.
  let usage!: Usage;
  let sessions!: Sessions;
  let automations!: Automations;
  let agents!: Agents;
  const users = usersArea({
    db,
    secret: (name) => secret("user-", name),
    clock,
    log: options.log("users"),
    projects: { createPersonal: (fields) => projects.createPersonal(fields) },
  });
  const limits = limitsArea({ db, clock });
  const providers = providersArea({
    db,
    clock,
    secret: (name) => secret("provider-", name),
    keys: () => options.secretNames?.("provider-") ?? [],
    fetcher: options.fetcher ?? fetch,
    agents: { usesProvider: (providerId) => agents.usesProvider(providerId) },
  });
  const mcp: Mcp = mcpArea({
    db,
    clock,
    secret: (name) => secret(MCP_KEY_PREFIX, name),
    keys: () => options.secretNames?.(MCP_KEY_PREFIX) ?? [],
    callTimeoutMs: () => limits.current().callTimeoutMs,
    fetcher: options.fetcher ?? fetch,
    log: options.log("mcp"),
    version: options.version,
    render: renderMarkdown,
  });
  const skills: Skills = skillsArea({
    db,
    clock,
    log: options.log("skills"),
    fetcher: options.fetcher ?? fetch,
    agents: {
      agentNames: (ids) =>
        ids.flatMap((id) => {
          const agent = agents.byId(id);
          return agent === null ? [] : [agent.name];
        }),
    },
  });
  const projects = projectsArea({
    db,
    clock,
    access: { project: (principal, id) => access.project(principal, id) },
    users,
    sessions: {
      count: (projectId) => sessions.store.count(projectId),
      running: (projectId) => sessions.store.running(projectId),
    },
    usage: {
      deleteProject: (projectId) => usage.deleteProject(projectId),
    },
    // the knowledge area is built after projects; until it lands the
    // detail counts nothing
    knowledge: { counts: () => ({ files: 0, tokens: 0 }) },
  });
  const access: Access = accessArea({
    db,
    clock,
    log: options.log("access"),
    secureCookie: options.secureCookie,
    users,
    projects,
  });
  usage = usageArea({
    db,
    clock,
    access: {
      visibleProjectIds: (userId) => access.visibleProjectIds(userId),
    },
  });
  agents = agentsArea({
    db,
    clock,
    providers,
    skills,
    mcp,
    tools: {
      offered: (now, agentId, agentServers, mode, scope) =>
        tools.offered(now, agentId, agentServers, mode, scope),
    },
    access,
    sessions: { usesAgent: (agentId) => sessions.usesAgent(agentId) },
    automations: {
      usesAgent: (agentId) => automations.usesAgent(agentId),
    },
  });
  const memory: MemoryArea = memoryArea({
    db,
    clock,
    access,
    users,
    runs: { runInfo: (sessionId) => sessions.runInfo(sessionId) },
  });
  sessions = sessionsArea({
    db,
    clock,
    log: options.log("sessions"),
    access,
    agents: { byId: (id) => agents.byId(id) },
    live: (sessionId) => runner.live(sessionId),
    usage,
    isWrite: (name) => mcp.isWrite(name),
  });
  const tools =
    options.tools ??
    toolsArea({
      db,
      fetcher: options.fetcher ?? fetch,
      secret: (name) => secret("search-", name),
      clock,
      log: options.log("tools"),
      version: options.version,
      render: renderMarkdown,
      skills,
      mcp,
      memory,
      sessions: {
        memorySnapshot: (projectId, sessionId) =>
          sessions.memorySnapshot(projectId, sessionId),
      },
      markers: {
        unread: (automationId, projectId, cap, exclude) =>
          automations.unread(automationId, projectId, cap, exclude),
      },
    });
  const socket = socketArea({
    refresh: (principal) => access.refresh(principal),
    visibleProjectIds: (userId) => access.visibleProjectIds(userId),
    sessionProject: (principal, id) => sessions.sessionProject(principal, id),
    live: (sessionId) => runner.live(sessionId),
  });
  const runner = runnerArea({
    db,
    clock,
    log: options.log("runner"),
    sessions: sessions.store,
    access,
    visible: (principal, id) => sessions.visible(principal, id),
    agents,
    users,
    providers,
    tools,
    memory: {
      read: (projectId, automationId) => memory.read(projectId, automationId),
      commit: (work, sessionId) => memory.commit(work, sessionId),
    },
    markers: {
      mark: (automationId, marks) => automations.mark(automationId, marks),
    },
    limits,
    usage,
    render: renderMarkdown,
    stream: (sessionId, frame) => socket.stream(sessionId, frame),
    registry: options.registry,
  });
  automations = automationsArea({
    db,
    clock,
    log: options.log("automations"),
    access,
    users,
    projects,
    agents,
    limits,
    memory,
    sessions: sessions.store,
    usage,
    runner,
  });
  if (options.activate !== false) {
    await users.bootstrap();
    sessions.repair();
    automations.start();
  }
  const routes: RouteDescriptor[] = [
    ...users.routes,
    ...usage.routes,
    ...limits.routes,
    ...providers.routes,
    ...mcp.routes,
    ...skills.routes,
    ...projects.routes,
    ...access.routes,
    ...agents.routes,
    ...memory.routes,
    ...sessions.routes,
    ...(tools.routes ?? []),
    ...runner.routes,
    ...automations.routes,
    socket.route,
    healthRoute(options.version),
  ];
  const handle = router({
    routes,
    resolve: (req) => access.resolve(req),
    trustProxy: options.trustProxy,
  });
  const provision = provisionArea({
    handle,
    secret,
    bootstrap: async () => (await users.bootstrap()) !== null,
    inventory: () => {
      const names = users.list().map((row) => row.username);
      return {
        User: names.length ? names : ["admin"],
        Project: projects.store
          .teamProjectIds()
          .map((id) => projects.store.byId(id)!.name),
        Provider: providers.store.list().map((row) => row.name),
        Skill: skills.store.summaries(() => []).map((row) => row.name),
        McpServer: mcp.store.list().map((row) => row.name),
        Agent: agents.store.list().map((row) => row.name),
        Tool: ["webfetch", "websearch", "visualize"],
      };
    },
  });
  return {
    users: users.store,
    projects: projects.store,
    providers: providers.store,
    mcp: mcp.store,
    skills: skills.store,
    agents: agents.store,
    memory: memory.store,
    sessions: sessions.store,
    automations: automations.store,
    automationScheduler: automations.scheduler,
    usage: usage.store,
    catalogs: providers.catalogs,
    chat: providers.chat,
    createUser: users.createUser,
    runner,
    socket,
    routes,
    handle,
    provision,
    sweep: () => access.sweep() + sessions.store.sweepDigests(),
    mcpStart: () => mcp.start(),
    // the runner first, whose ending calls may still ask for a refresh
    // that the MCP close then refuses; nothing touches the db after
    async shutdown() {
      skills.close();
      automations.stop();
      await runner.shutdown();
      await mcp.close();
      automations.dispose();
      socket.dispose();
    },
  };
}
