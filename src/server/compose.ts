// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The composition root: the areas in layer order, each built by its
// own factory with the capabilities of the areas it declared ports to,
// the complete route list, the router. main.ts calls it with the
// flags; the test helper calls it with a memory db and a fake clock,
// so a test exercises the wiring the binary runs.

import { availableParallelism } from "node:os";
import { WAIT_GRACE_MS } from "../shared/contracts/automation.ts";
import {
  EMAIL_KEY_PREFIX,
  MCP_KEY_PREFIX,
  type SecretKind,
} from "../shared/words.ts";
import { type Access, accessArea } from "./access/index.ts";
import { type AgentStore, type Agents, agentsArea } from "./agents/index.ts";
import { type Automations, automationsArea } from "./automations/index.ts";
import { type BashArea, bashArea } from "./bash/index.ts";
import { credentialsArea, httpKeys } from "./credentials/index.ts";
import type { Db } from "./db/index.ts";
import { type Deciders, decidersArea } from "./deciders/index.ts";
import {
  type Email,
  type EmailSender,
  emailArea,
  smtpSender,
} from "./email/index.ts";
import {
  acquireProcess,
  type KnowledgeArea,
  knowledgeArea,
} from "./knowledge/index.ts";
import type { Clock } from "./lib/clock.ts";
import { userAgent, withUserAgent } from "./lib/fetcher.ts";
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
import {
  inventoryOf,
  type Provision,
  projectDocsOf,
  provisionArea,
} from "./provision/index.ts";
import { renderMarkdown } from "./render/index.ts";
import {
  type JobRunner,
  type Repos,
  reposArea,
  workerJobs,
} from "./repos/index.ts";
import {
  type DrainResult,
  type Runner,
  runnerArea,
  type ShutdownResult,
} from "./runner/index.ts";
import {
  type KeptPass,
  type SessionStore,
  type Sessions,
  sessionsArea,
} from "./sessions/index.ts";
import { type SkillStore, type Skills, skillsArea } from "./skills/index.ts";
import { type Tools, toolsArea } from "./tools/index.ts";
import { type UsageStore, usageArea } from "./usage/index.ts";
import {
  type PasswordCost,
  type UserStore,
  type Users,
  usersArea,
} from "./users/index.ts";
import { healthRoutes } from "./web/health.ts";
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
  // how long a shutdown waits for running sends to end on their own
  drainMs?: number;
  // a test seam for the runner's tool state machine
  tools?: Tools;
  // a test's command worker entry; the real one by default
  commandWorker?: URL;
  // the repositories' cache directory; none fetches nothing
  cacheDir?: string | null;
  // a test's repository fetches; the fetch worker by default
  repoJobs?: JobRunner;
  // Provisioning validates before bootstrap and never repairs or schedules.
  activate?: boolean;
  // argon2id's cost; a test passes the least
  passwordCost?: PasswordCost;
  // the cores the send caps are sized by; a test passes a fixed number
  cores?: number;
  // what reaches the SMTP server; a test passes a fake that records
  emailSender?: EmailSender;
};

export type App = {
  users: UserStore;
  projects: ProjectStore;
  providers: ProviderStore;
  mcp: McpServerStore;
  skills: SkillStore;
  agents: AgentStore;
  deciders: Deciders;
  memory: MemoryStore;
  knowledge: KnowledgeArea;
  repos: Repos;
  // the cache directory as startup found it
  repoCache: { dir: string; trees: number; bytes: number } | null;
  bash: BashArea;
  sessions: SessionStore;
  automations: Automations["store"];
  automationScheduler: Automations["scheduler"];
  usage: UsageStore;
  catalogs: Catalogs;
  chat: Providers["chat"];
  // the one way a user is made: with its personal project
  createUser: Users["createUser"];
  email: Email;
  runner: Runner;
  socket: Socket;
  routes: RouteDescriptor[];
  handle: Router;
  provision: Provision;
  repaired: number;
  reconciled: number;
  // drop expired logins and links and sweep the chats; called at start
  // and every hour; the rows removed, not the chats swept
  sweep(): number;
  // the work a link ask left after its 202
  linkAsks(): Promise<void>;
  // the hourly MCP refresh loop; main.ts starts it after the first
  // sweep, a test only when it tests the pass
  mcpStart(): void;
  // the kept files job: a pass now, then hourly; main.ts starts it after
  // the first sweep
  keptStart(): void;
  // one pass of the kept files job to its end, or the one running
  packKept(): Promise<KeptPass>;
  // drain, terminate what is left and close every socket, in that
  // order; cut ends the drain's wait
  shutdown(cut?: Promise<void>): Promise<ShutdownResult & DrainResult>;
};

const SCRUB_KINDS: SecretKind[] = [
  "provider-",
  "search-",
  "mcp-",
  "http-",
  "email-",
];

export function scrubbedLogs(
  options: Pick<ComposeOptions, "secret" | "secretNames" | "log">,
): LogFactory {
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
  // ports to areas built later are closures, called once the list is
  // complete
  let sessions!: Sessions;
  let automations!: Automations;
  let agents!: Agents;
  let repos!: Repos;
  const users = usersArea({
    db,
    secret: (name) => secret("user-", name),
    clock,
    log: log("users"),
    projects: { createPersonal: (fields) => projects.createPersonal(fields) },
    passwordCost: options.passwordCost,
  });
  const email = emailArea({
    db,
    clock,
    log: log("email"),
    secret: (name) => secret(EMAIL_KEY_PREFIX, name),
    keys: () => options.secretNames?.(EMAIL_KEY_PREFIX) ?? [],
    users,
    emailSender: options.emailSender ?? smtpSender(),
  });
  // the instance's start, as the overview reports it
  const startedAt = clock();
  const fetcher = withUserAgent(options.fetcher ?? fetch, options.version);
  // the queue first, so a waiting message takes a place before a run
  const wake = () => {
    runner.queue.wake();
    automations.scheduler.wake();
  };
  const limits = limitsArea({
    db,
    clock,
    cores: options.cores ?? availableParallelism(),
    wake,
  });
  const usage = usageArea({
    db,
    clock,
    access: {
      visibleProjectIds: (userId) => access.visibleProjectIds(userId),
    },
  });
  const projectTotal = (projectId: string, since: number, until: number) =>
    usage.total({ projectId }, since, until);
  const providers = providersArea({
    db,
    clock,
    secret: (name) => secret("provider-", name),
    keys: () => options.secretNames?.("provider-") ?? [],
    fetcher,
    log: log("providers"),
    agents: { usesProvider: (providerId) => agents.usesProvider(providerId) },
    deciders: {
      usesProvider: (providerId) => deciders.usesProvider(providerId),
    },
    usage: {
      providerTotal: (providerId, since, until) =>
        usage.total({ providerId }, since, until),
    },
  });
  const deciders = decidersArea({
    db,
    clock,
    log: log("deciders"),
    providers,
    usage,
  });
  // a deleted object leaves no key behind in a chat or a task; a
  // repository was its project's, so only that project's rows are read
  const capabilities = {
    forget(key: string, projectId?: string) {
      sessions.store.forgetCapability(key, projectId);
      automations.store.forgetCapability(key, projectId);
    },
  };
  const agentNames = {
    byId: (id: string) => agents.byId(id),
    byName: (name: string) => agents.store.byName(name),
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
    usage: {
      calls: (server, since, until) => sessions.mcpCalls(server, since, until),
      servers: (since, until) => sessions.mcpServerCalls(since, until),
    },
  });
  const skills: Skills = skillsArea({
    db,
    clock,
    log: log("skills"),
    fetcher,
    capabilities,
    usage: { loads: (since, until) => sessions.skillLoads(since, until) },
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
      dropQueued: (projectId, userId) => sessions.dropQueued(projectId, userId),
    },
    knowledge: {
      counts: (projectId) => knowledge.counts(projectId),
      latest: (projectId, limit) => knowledge.latest(projectId, limit),
    },
    usage: { projectTotal },
  });
  const credentials = credentialsArea({
    db,
    clock,
    projects: projects.store,
    key: httpKeys(options),
    capabilities,
    repos: { usingKeys: () => repos.usingKeys() },
  });
  // who an agent's email or an alert may reach: a user who can open the
  // project, so no email tells anyone what the app would not show them
  const canOpen = (userId: string, projectId: string) =>
    access.visibleProjectIds(userId)?.includes(projectId) ?? false;
  const outbox = {
    enabled: () => email.enabled(),
    link: (path: string) => email.link(path),
    enqueue: email.enqueue,
    register: email.register,
  };
  const access: Access = accessArea({
    db,
    clock,
    log: log("access"),
    secureCookie: options.secureCookie,
    users,
    projects,
    usage: {
      projectTotal,
      activeProjects: (ids, since, until) =>
        usage.activeProjects(ids, since, until),
    },
    activity: { personDays: (...args) => sessions.personDays(...args) },
    presence: { onlineUserIds: () => socket.onlineUserIds() },
    email,
  });
  agents = agentsArea({
    db,
    clock,
    providers,
    skills,
    mcp,
    credentials,
    repos: { switchable: (projectId) => repos.switchable(projectId) },
    tools: {
      capabilities: () => tools.capabilities(),
      offered: (now, agentId, agentServers, mode, scope) =>
        tools.offered(now, agentId, agentServers, mode, scope),
    },
    access,
    sessions: () => sessions,
    automations: () => automations,
    runner: () => runner,
    usage: {
      agentDays: (agentId, timeZone) => usage.agentDays(agentId, timeZone),
      agentTotal: (agentId, since, until) =>
        usage.total({ agentId }, since, until),
    },
    users,
  });
  const memory: MemoryArea = memoryArea({
    db,
    clock,
    access,
    users,
    sessions: { sessionInfo: (sessionId) => sessions.sessionInfo(sessionId) },
  });
  const knowledge = knowledgeArea({ db, clock, limits, access });
  repos = reposArea({
    db,
    clock,
    access,
    projects: projects.store,
    keys: { readKey: (keyName) => credentials.readKey(keyName) },
    capabilities,
    cacheDir: options.cacheDir ?? null,
    // built here, at the compile root, so the binary finds its entry
    jobs:
      options.repoJobs ??
      workerJobs(new URL("./repos/fetch.worker.ts", import.meta.url)),
    fetch: fetcher,
    limits: () => limits.current(),
    log: log("repos"),
    acquire: acquireProcess,
    userAgent: userAgent(options.version),
  });
  const bash = bashArea({
    db,
    clock,
    limits,
    log: log("bash"),
    // built here, at the compile root, so the binary finds its entry
    worker:
      options.commandWorker ??
      new URL("./bash/command.worker.ts", import.meta.url),
    knowledge: {
      mountedDocs: (projectId) => knowledge.mountedDocs(projectId),
      mountedUploads: (sessionId) => knowledge.mountedUploads(sessionId),
      commitDocs: (projectId, author, changes, caps, now) =>
        knowledge.commitDocs(projectId, author, changes, caps, now),
    },
  });
  sessions = sessionsArea({
    db,
    clock,
    log: log("sessions"),
    access,
    agents: agentNames,
    live: (sessionId) => runner.live(sessionId),
    usage,
    limits,
    uploads: knowledge,
    scratch: bash.scratch,
    wakeQueue: () => runner.queue.wake(),
    pruned: (run) => automations.runDeleted(run),
  });
  const configuredTools = toolsArea({
    db,
    fetcher,
    secret: (name) => secret("search-", name),
    clock,
    log: log("tools"),
    render: renderMarkdown,
    skills,
    mcp,
    memory,
    bash,
    credentials,
    usage: {
      visuals: (since, until) => sessions.visualCounts(since, until),
      web: (since, until) => sessions.webCounts(since, until),
    },
    email: {
      enabled: outbox.enabled,
      outbox: {
        ...outbox,
        countSession: (sessionId, kind, since) =>
          email.store.countSession(sessionId, kind, since),
        countProject: (projectId, kind, since) =>
          email.store.countProject(projectId, kind, since),
      },
      users,
      canOpen,
      projects: projects.store,
    },
    // a closure: the runner is built after the tools
    delegate: (input, call, ctx) => runner.delegate(input, call, ctx),
  });
  const tools = options.tools ?? configuredTools;
  const socket = socketArea({
    version: options.version,
    log: log("socket"),
    refresh: (principal) => access.refresh(principal),
    visibleProjectIds: (userId) => access.visibleProjectIds(userId),
    sessionProject: (principal, id) => sessions.sessionProject(principal, id),
    envelopeRow: (sessionId) => sessions.envelopeRow(sessionId),
    live: (sessionId) => runner.live(sessionId),
    queue: (sessionId) => sessions.queueFrame(sessionId),
    children: (sessionId) => sessions.runningChildren(sessionId),
  });
  const runner = runnerArea({
    db,
    clock,
    log: log("runner"),
    sessions: sessions.store,
    access,
    visible: (principal, id) => sessions.visible(principal, id),
    agents: agentNames,
    users,
    providers,
    tools,
    knowledge,
    bash,
    repos: {
      prepare: (projectId, options) => repos.prepare(projectId, options),
      switchable: (projectId) => repos.switchable(projectId),
    },
    uploads: {
      checkUploads: (userId, projectId, ids) =>
        knowledge.checkUploads(userId, projectId, ids),
      claimUploads: (projectId, sessionId, claims) =>
        knowledge.claimUploads(projectId, sessionId, claims),
    },
    memory: {
      read: (projectId, automationId) => memory.read(projectId, automationId),
      commit: (work, sessionId) => memory.commit(work, sessionId),
      view: (sessionId) => memory.view(sessionId),
      startView: (sessionId, snapshot) => memory.startView(sessionId, snapshot),
      endView: (sessionId) => memory.endView(sessionId),
      resetSeen: (sessionId) => memory.resetSeen(sessionId),
    },
    limits,
    usage,
    render: renderMarkdown,
    stream: (sessionId, frame) => socket.stream(sessionId, frame),
    wake,
    attention: {
      decide: (...args) => deciders.decide(...args),
      decision: () => deciders.decision("run-attention"),
      runAnswer: (sendId, memoryRound) =>
        sessions.runAnswer(sendId, memoryRound),
      markAttention: (sessionId, attention, by) =>
        automations.alerts.decided(sessionId, attention, by),
      undecided: (sessionId) => automations.alerts.undecided(sessionId),
    },
    alerts: {
      runEnded: (run, change) => automations.alerts.runEnded(run, change),
    },
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
    runner,
    markAttention: (sessionId, attention, by) =>
      sessions.markAttention(sessionId, attention, by),
    email: {
      outbox: {
        ...outbox,
        countAlerts: (automationId, since) =>
          email.store.countAlerts(automationId, since),
      },
      canOpen,
    },
    deciderOn: () => {
      const decision = deciders.decision("run-attention");
      const named =
        decision.deciderId === null
          ? null
          : deciders.store.byId(decision.deciderId);
      // a decision whose decider is gone asks the default, as decide() does
      return decision.enabled && (named ?? deciders.current()) !== null;
    },
  });
  const overview: Overview = overviewArea({
    db,
    clock,
    log: log("overview"),
    limits,
    version: options.version,
    startedAt,
    running: (perProject) => runner.registry.running(perProject),
    online: () => socket.online(),
    automations: () => automations.store.tally(clock() - WAIT_GRACE_MS),
    queue: () => sessions.store.queue.load(),
    attention: () => {
      const keyed = (kind: SecretKind, name: string | null) =>
        name !== null && secret(kind, name) !== null;
      const search = configuredTools.store.row("websearch").provider;
      return {
        providers: providers.store.list().map((p) => ({
          name: p.name,
          keyName: p.keyName,
          hasKey: keyed("provider-", p.keyName),
        })),
        mcp: mcp.store.list().map((s) => ({
          name: s.name,
          keyName: s.keyName,
          hasKey: keyed(MCP_KEY_PREFIX, s.keyName),
          refreshFailedAt: s.refreshFailedAt,
        })),
        skills: skills.store.list().map((s) => ({
          name: s.name,
          refreshFailedAt: s.refreshFailedAt,
        })),
        credentials: credentials.store.list().map((c) => ({
          name: c.name,
          key: credentials.keyState(c.keyName),
        })),
        search: {
          provider: search,
          hasKey: keyed("search-", search === null ? null : `search-${search}`),
        },
        email: email.attention(),
      };
    },
    // built here, at the compile root, so the binary finds its entry
    worker: new URL("./overview/scan.worker.ts", import.meta.url),
  });
  let repaired = 0;
  let reconciled = 0;
  let repoCache: App["repoCache"] = null;
  // from the first signal to the exit
  let draining = false;
  if (options.activate !== false) {
    await users.bootstrap();
    repaired = sessions.repair();
    // before the queue, so a resumed send never sees a tree the cache drops
    repoCache = repos.start();
    runner.queue.start();
    reconciled = automations.start();
    overview.start();
    email.start();
  }
  const routes: RouteDescriptor[] = [
    ...usage.routes,
    ...limits.routes,
    ...email.routes,
    ...providers.routes,
    ...deciders.routes,
    ...mcp.routes,
    ...skills.routes,
    ...projects.routes,
    ...credentials.routes,
    ...access.routes,
    ...agents.routes,
    ...memory.routes,
    ...knowledge.routes,
    ...repos.routes,
    ...sessions.routes,
    ...(tools.routes ?? []),
    ...runner.routes,
    ...automations.routes,
    ...overview.routes,
    socket.route,
    ...healthRoutes(options.version, () => draining),
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
    projectDocs: projectDocsOf({
      projects: projects.store,
      limits,
      docs: knowledge.store,
    }),
    credentials: { key: credentials.keyState, list: credentials.bindings },
    smtp: () => {
      const held = email.settings();
      return held && { username: held.username, keyName: held.keyName };
    },
    inventory: () =>
      inventoryOf({
        users,
        projects: projects.store,
        credentials: credentials.store,
        repos: repos.store,
        providers: providers.store,
        deciders: deciders.store,
        skills: skills.store,
        mcp: mcp.store,
        agents: agents.store,
        email,
      }),
  });
  const sweepLog = log("sweep");
  return {
    users: users.store,
    projects: projects.store,
    providers: providers.store,
    mcp: mcp.store,
    skills: skills.store,
    agents: agents.store,
    deciders,
    memory: memory.store,
    knowledge,
    repos,
    repoCache,
    bash,
    sessions: sessions.store,
    automations: automations.store,
    automationScheduler: automations.scheduler,
    usage: usage.store,
    catalogs: providers.catalogs,
    chat: providers.chat,
    createUser: users.createUser,
    email,
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
        const links = access.sweepLinks();
        const visits = access.sweepVisits();
        const now = clock();
        const knowledgeRows = knowledge.sweep(now);
        const scratchRows = bash.sweep(now);
        const digests = sessions.store.sweepDigests();
        const chats = sessions.sweep(now, limits.current());
        repos.sweep();
        // an idle chat archived may hold messages that now cannot start
        if (chats.chats_archived > 0) runner.queue.wake();
        const notSent = sessions.sweepNotSent(now);
        const emailRows = email.sweep(now);
        const removed =
          logins +
          links +
          visits +
          knowledgeRows +
          scratchRows +
          digests +
          notSent +
          emailRows;
        if (removed > 0 || Object.values(chats).some((n) => n > 0)) {
          sweepLog.info("sweep", {
            logins,
            links,
            visits,
            knowledge: knowledgeRows,
            bash: scratchRows,
            digests,
            not_sent: notSent,
            emails: emailRows,
            removed,
            ...chats,
          });
        }
        return removed;
      } catch (error) {
        sweepLog.warn("sweep failed", errorFields(error, false));
        throw error;
      }
    },
    linkAsks: () => access.settled(),
    mcpStart: () => mcp.start(),
    keptStart: () => sessions.kept.start(),
    packKept: () => sessions.kept.pass(),
    // the drain first, while the listener still serves; then the runner,
    // whose ending calls may still ask for a refresh that the MCP close
    // then refuses, then any command it left running, both within the
    // runner's wait; nothing touches the db after
    async shutdown(cut) {
      draining = true;
      // first: from here every message is queued for the next start
      runner.queue.close();
      automations.drain();
      // no row is taken from here; the one in flight ends below
      const emailStopped = email.stop();
      repos.close();
      // no kept files batch starts from here; the wait below is for the
      // one in flight, its compression and its commit
      const packing = sessions.kept.stop();
      const { drained } = await runner.drain(options.drainMs ?? 0, cut);
      skills.close();
      const result = await runner.shutdown(async () => {
        bash.close();
        await mcp.close();
      });
      automations.stop();
      automations.dispose();
      // a link ask answered before here writes its row; one after does
      // nothing, since the listener still serves until the db closes
      await access.closeLinks();
      if (cut === undefined) await emailStopped;
      else {
        await Promise.race([emailStopped, cut]);
        // a send the cut left in flight must not write once the db closes
        email.halt();
      }
      email.dispose();
      await packing;
      overview.close();
      socket.dispose();
      return { ...result, drained };
    },
  };
}
