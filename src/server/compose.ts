// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The composition root: the areas in layer order, each built by its
// own factory with the capabilities of the areas it declared ports to,
// the complete route list, the router. main.ts calls it with the
// flags; the test helper calls it with a memory db and a fake clock,
// so a test exercises the wiring the binary runs.

import { WAIT_GRACE_MS } from "../shared/contracts/automation.ts";
import { MCP_KEY_PREFIX, type SecretKind } from "../shared/words.ts";
import { type Access, accessArea } from "./access/index.ts";
import { type AgentStore, type Agents, agentsArea } from "./agents/index.ts";
import { type Automations, automationsArea } from "./automations/index.ts";
import { credentialsArea, httpKeys } from "./credentials/index.ts";
import type { Db } from "./db/index.ts";
import { type KnowledgeArea, knowledgeArea } from "./knowledge/index.ts";
import type { Clock } from "./lib/clock.ts";
import { withUserAgent } from "./lib/fetcher.ts";
import type { RouteDescriptor } from "./lib/http.ts";
import { errorFields, type LogFactory, scrubErrors } from "./lib/log.ts";
import { limitsArea } from "./limits/index.ts";
import { type Mcp, type McpServerStore, mcpArea } from "./mcp/index.ts";
import {
  type MemoryArea,
  type MemoryStore,
  memoryArea,
} from "./memory/index.ts";
import { type Overview, overviewArea } from "./overview/index.ts";
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
import {
  type Registry,
  type Runner,
  runnerArea,
  type ShutdownResult,
} from "./runner/index.ts";
import {
  type SessionStore,
  type Sessions,
  sessionsArea,
} from "./sessions/index.ts";
import { type SkillStore, type Skills, skillsArea } from "./skills/index.ts";
import { type Tools, toolsArea } from "./tools/index.ts";
import { type Usage, type UsageStore, usageArea } from "./usage/index.ts";
import {
  type PasswordCost,
  type UserStore,
  type Users,
  usersArea,
} from "./users/index.ts";
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
  log: LogFactory;
  version: string;
  secureCookie: boolean;
  trustProxy: boolean;
  // a test seam for the runner's tool state machine
  tools?: Tools;
  // a test's registry with its own caps
  registry?: Registry;
  // Provisioning validates before bootstrap and never repairs or schedules.
  activate?: boolean;
  // argon2id's cost; a test passes the least
  passwordCost?: PasswordCost;
};

export type App = {
  users: UserStore;
  projects: ProjectStore;
  providers: ProviderStore;
  mcp: McpServerStore;
  skills: SkillStore;
  agents: AgentStore;
  memory: MemoryStore;
  knowledge: KnowledgeArea;
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
  repaired: number;
  reconciled: number;
  // drop expired logins; called at start and every hour
  sweep(): number;
  // the hourly MCP refresh loop; main.ts starts it after the first
  // sweep, a test only when it tests the pass
  mcpStart(): void;
  // terminate every send and close every socket, in that order
  shutdown(): Promise<ShutdownResult>;
};

const SCRUB_KINDS: SecretKind[] = ["provider-", "search-", "mcp-", "http-"];

function scrubbedLogs(options: ComposeOptions): LogFactory {
  const { scrubbed } = httpKeys(options);
  return (area) =>
    scrubErrors(options.log(area), () =>
      SCRUB_KINDS.flatMap((kind) =>
        (options.secretNames?.(kind) ?? []).flatMap((name) => {
          const value = scrubbed(kind, name);
          return value === null ? [] : [value];
        }),
      ),
    );
}

export async function compose(options: ComposeOptions): Promise<App> {
  const { db, clock, secret } = options;
  const log = scrubbedLogs(options);
  // Ports that point down the list, at an area built after the one that
  // holds them, are closures called once the list is complete: a user
  // is made with its personal project, project routes read sessions and
  // usage built later, a provider an agent runs on and an agent a chat
  // runs on cannot go, a project route asks access what the principal
  // may see, the session detail asks the runner for the reply in
  // flight, and a freed run slot or a moved run cap wakes the scheduler.
  let usage!: Usage;
  let sessions!: Sessions;
  let automations!: Automations;
  let agents!: Agents;
  const users = usersArea({
    db,
    secret: (name) => secret("user-", name),
    clock,
    log: log("users"),
    projects: { createPersonal: (fields) => projects.createPersonal(fields) },
    passwordCost: options.passwordCost,
  });
  // the instance's start, as the overview reports it
  const startedAt = clock();
  const fetcher = withUserAgent(options.fetcher ?? fetch, options.version);
  const limits = limitsArea({
    db,
    clock,
    runCapsChanged: () => automations.scheduler.wake(),
  });
  const providers = providersArea({
    db,
    clock,
    secret: (name) => secret("provider-", name),
    keys: () => options.secretNames?.("provider-") ?? [],
    fetcher,
    log: log("providers"),
    agents: { usesProvider: (providerId) => agents.usesProvider(providerId) },
  });
  // a deleted server or skill leaves no key behind in a chat or a task
  const capabilities = {
    forget(key: string) {
      sessions.store.forgetCapability(key);
      automations.store.forgetCapability(key);
    },
  };
  const mcp: Mcp = mcpArea({
    db,
    clock,
    secret: (name) => secret(MCP_KEY_PREFIX, name),
    keys: () => options.secretNames?.(MCP_KEY_PREFIX) ?? [],
    callTimeoutMs: () => limits.current().callTimeoutMs,
    fetcher,
    log: log("mcp"),
    version: options.version,
    render: renderMarkdown,
    capabilities,
  });
  const skills: Skills = skillsArea({
    db,
    clock,
    log: log("skills"),
    fetcher,
    capabilities,
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
    knowledge: { counts: (projectId) => knowledge.counts(projectId) },
  });
  const credentials = credentialsArea({
    db,
    clock,
    projects: projects.store,
    key: httpKeys(options),
    capabilities,
  });
  const access: Access = accessArea({
    db,
    clock,
    log: log("access"),
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
      capabilities: () => tools.capabilities(),
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
  const knowledge = knowledgeArea({ db, clock, limits, access });
  sessions = sessionsArea({
    db,
    clock,
    log: log("sessions"),
    access,
    agents: { byId: (id) => agents.byId(id) },
    live: (sessionId) => runner.live(sessionId),
    usage,
    uploads: {
      copyUploads: (sourceId, targetId, restage, messageIds) =>
        knowledge.copyUploads(sourceId, targetId, restage, messageIds),
    },
    isWrite: (name) => mcp.isWrite(name),
  });
  const configuredTools = toolsArea({
    db,
    fetcher,
    secret: (name) => secret("search-", name),
    clock,
    log: log("tools"),
    version: options.version,
    render: renderMarkdown,
    skills,
    mcp,
    memory,
    knowledge,
    sessions: {
      memorySnapshot: (projectId, sessionId) =>
        sessions.memorySnapshot(projectId, sessionId),
    },
    markers: {
      unread: (automationId, projectId, cap, exclude) =>
        automations.unread(automationId, projectId, cap, exclude),
    },
  });
  const tools = options.tools ?? configuredTools;
  const socket = socketArea({
    version: options.version,
    log: log("socket"),
    refresh: (principal) => access.refresh(principal),
    visibleProjectIds: (userId) => access.visibleProjectIds(userId),
    sessionProject: (principal, id) => sessions.sessionProject(principal, id),
    live: (sessionId) => runner.live(sessionId),
  });
  const runner = runnerArea({
    db,
    clock,
    log: log("runner"),
    sessions: sessions.store,
    access,
    visible: (principal, id) => sessions.visible(principal, id),
    agents,
    users,
    providers,
    tools,
    knowledge,
    uploads: {
      checkUploads: (userId, projectId, ids) =>
        knowledge.checkUploads(userId, projectId, ids),
      claimUploads: (userId, projectId, sessionId, messageId, ids) =>
        knowledge.claimUploads(userId, projectId, sessionId, messageId, ids),
    },
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
    slotFreed: () => automations.scheduler.wake(),
  });
  automations = automationsArea({
    db,
    clock,
    log: log("automations"),
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
  const overview: Overview = overviewArea({
    db,
    clock,
    log: log("overview"),
    limits,
    version: options.version,
    startedAt,
    pools: () => ({
      ...runner.registry.running(),
      chatsCap: runner.registry.chatsCap,
    }),
    online: () => socket.online(),
    automations: () => automations.store.tally(clock() - WAIT_GRACE_MS),
    // built here, at the compile root, so the binary finds its entry
    worker: new URL("./overview/scan.worker.ts", import.meta.url),
  });
  let repaired = 0;
  let reconciled = 0;
  if (options.activate !== false) {
    await users.bootstrap();
    repaired = sessions.repair();
    reconciled = automations.start();
    overview.start();
  }
  const routes: RouteDescriptor[] = [
    ...users.routes,
    ...usage.routes,
    ...limits.routes,
    ...providers.routes,
    ...mcp.routes,
    ...skills.routes,
    ...projects.routes,
    ...credentials.routes,
    ...access.routes,
    ...agents.routes,
    ...memory.routes,
    ...knowledge.routes,
    ...sessions.routes,
    ...(tools.routes ?? []),
    ...runner.routes,
    ...automations.routes,
    ...overview.routes,
    socket.route,
    healthRoute(options.version),
  ];
  const handle = router({
    routes,
    resolve: (req) => access.resolve(req),
    trustProxy: options.trustProxy,
    log: log("router"),
  });
  const provision = provisionArea({
    handle,
    secret,
    webAccess: () => configuredTools.webAccess(),
    bootstrap: async () => (await users.bootstrap()) !== null,
    projectDocs: (name) => {
      const id = projects.store
        .teamProjectIds()
        .find((id) => projects.store.byId(id)?.name === name);
      return {
        caps: limits.current(),
        live: id === undefined ? [] : knowledge.store.list(id),
      };
    },
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
        Tool: ["web", "websearch", "visualize"],
      };
    },
  });
  const sweepLog = log("sweep");
  return {
    users: users.store,
    projects: projects.store,
    providers: providers.store,
    mcp: mcp.store,
    skills: skills.store,
    agents: agents.store,
    memory: memory.store,
    knowledge,
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
    repaired,
    reconciled,
    sweep: () => {
      try {
        const logins = access.sweep();
        const knowledgeRows = knowledge.sweep(clock());
        const digests = sessions.store.sweepDigests();
        const removed = logins + knowledgeRows + digests;
        if (removed > 0) {
          sweepLog.info("sweep", {
            logins,
            knowledge: knowledgeRows,
            digests,
            removed,
          });
        }
        return removed;
      } catch (error) {
        sweepLog.warn("sweep failed", errorFields(error, false));
        throw error;
      }
    },
    mcpStart: () => mcp.start(),
    // the runner first, whose ending calls may still ask for a refresh
    // that the MCP close then refuses; nothing touches the db after
    async shutdown() {
      skills.close();
      automations.stop();
      const result = await runner.shutdown();
      await mcp.close();
      automations.dispose();
      overview.close();
      socket.dispose();
      return result;
    },
  };
}
