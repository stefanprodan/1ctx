// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The composition root: the areas in layer order, each built by its
// own factory with the capabilities of the areas it declared ports to,
// the complete route list, the router. main.ts calls it with the
// flags; the test helper calls it with a memory db and a fake clock,
// so a test exercises the wiring the binary runs.

import { type Access, accessArea } from "./access/index.ts";
import { type AgentStore, agentsArea } from "./agents/index.ts";
import { type Automations, automationsArea } from "./automations/index.ts";
import type { Db } from "./db/index.ts";
import type { Clock } from "./lib/clock.ts";
import type { RouteDescriptor } from "./lib/http.ts";
import type { Log } from "./lib/log.ts";
import { limitsArea } from "./limits/index.ts";
import { type ProjectStore, projectsArea } from "./projects/index.ts";
import {
  type Catalogs,
  type Fetcher,
  type ProviderStore,
  type Providers,
  providersArea,
} from "./providers/index.ts";
import { renderMarkdown } from "./render/index.ts";
import { type Registry, type Runner, runnerArea } from "./runner/index.ts";
import {
  type SessionStore,
  type Sessions,
  sessionsArea,
} from "./sessions/index.ts";
import { type Tools, toolsArea } from "./tools/index.ts";
import { type Usage, type UsageStore, usageArea } from "./usage/index.ts";
import { type UserStore, type Users, usersArea } from "./users/index.ts";
import { healthRoute } from "./web/health.ts";
import { type Router, router } from "./web/router.ts";
import { type Socket, socketArea } from "./web/socket.ts";

export type ComposeOptions = {
  db: Db;
  // the secrets port: the bare value or null
  secret: (name: string) => string | null;
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
};

export type App = {
  users: UserStore;
  projects: ProjectStore;
  providers: ProviderStore;
  agents: AgentStore;
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
  // drop expired logins; called at start and every hour
  sweep(): number;
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
  const users = usersArea({
    db,
    secret,
    clock,
    log: options.log("users"),
    projects: { createPersonal: (fields) => projects.createPersonal(fields) },
  });
  const limits = limitsArea({ db, clock });
  const providers = providersArea({
    db,
    clock,
    secret,
    fetcher: options.fetcher ?? fetch,
    agents: { usesProvider: (providerId) => agents.usesProvider(providerId) },
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
  const agents = agentsArea({
    db,
    clock,
    providers,
    access,
    sessions: { usesAgent: (agentId) => sessions.usesAgent(agentId) },
    automations: {
      usesAgent: (agentId) => automations.usesAgent(agentId),
    },
  });
  sessions = sessionsArea({
    db,
    clock,
    log: options.log("sessions"),
    access,
    live: (sessionId) => runner.live(sessionId),
    usage,
  });
  const tools =
    options.tools ??
    toolsArea({
      db,
      fetcher: options.fetcher ?? fetch,
      secret,
      clock,
      log: options.log("tools"),
      version: options.version,
      render: renderMarkdown,
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
    sessions: sessions.store,
    usage,
    runner,
  });
  await users.bootstrap();
  sessions.repair();
  automations.start();
  const routes: RouteDescriptor[] = [
    ...users.routes,
    ...usage.routes,
    ...limits.routes,
    ...providers.routes,
    ...projects.routes,
    ...access.routes,
    ...agents.routes,
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
  return {
    users: users.store,
    projects: projects.store,
    providers: providers.store,
    agents: agents.store,
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
    sweep: () => access.sweep(),
    async shutdown() {
      automations.stop();
      await runner.shutdown();
      automations.dispose();
      socket.dispose();
    },
  };
}
