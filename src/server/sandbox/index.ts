// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sandbox shell: bash's commands in an OpenShell sandbox per chat,
// its subagents' included, when an admin picks it for the instance or a
// project and the gateway is set up. The area keeps the settings row,
// one gateway's leases at a time, and the ShellBackend bash asks for at
// each command.

import type { SandboxResponse } from "../../shared/api/sandbox.ts";
import {
  SANDBOX_KEYS,
  type SandboxBackend,
  type SandboxKeyRole,
} from "../../shared/contracts/sandbox.ts";
import { type SandboxNet, sandboxNet } from "../../shared/sandbox-net.ts";
import type { ShellBackend } from "../bash/index.ts";
import type { Db } from "../db/index.ts";
import { subscribe } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import type { KnowledgeCaps, SandboxCaps } from "../limits/index.ts";
import { sandboxBackend } from "./backend.ts";
import { recyclesOf } from "./events.ts";
import type { Connect, Gateway, GatewayConfig } from "./gateway.ts";
import { Leases } from "./leases.ts";
import { routes } from "./routes.ts";
import { defaultImage, gatewayLabel } from "./spec.ts";
import { SandboxStore } from "./store.ts";

export type {
  BindMount,
  Connect,
  CreateSpec,
  ExecEvent,
  ExecRequest,
  Gateway,
  GatewayConfig,
  ProfileSpec,
  ProviderSpec,
  ProviderState,
  SandboxInfo,
  SandboxPhase,
  SandboxPolicy,
  TmpfsMount,
} from "./gateway.ts";
export { KEEP_ALIVE_COMMAND, keepAlivePid } from "./keepalive.ts";
export {
  DELETE_RETRY_MS,
  DELETE_TIMEOUT_MS,
  Leases,
  REFILL_BACKOFF_MS,
  RETIRED_STUCK_CHECKS,
  type RecycleReason,
  type SandboxHold,
  STUCK_CHECK_MS,
  WARM_CREATE_MS,
} from "./leases.ts";
export { GLOBAL_POLICY_REFUSAL, READY_MS } from "./network.ts";
export { openshellGateway } from "./openshell.ts";
export {
  createSpec,
  defaultImage,
  INSTANCE_LABEL,
  KEEP_ALIVE,
  POLICY,
  SANDBOX_ENV,
} from "./spec.ts";
export { HEALTH_MS } from "./watch.ts";

export type SandboxDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  // the server's version, which names the default image
  version: string;
  // a sandbox- secret file's value, or null
  secret(name: string): string | null;
  limits(): KnowledgeCaps & SandboxCaps;
  repos: { hold(tree: string): (() => void) | null };
  connect: Connect;
  // a project's own backend over the instance's, an area above
  projects: {
    // null follows the instance's, as does a project not found
    backend(projectId: string): SandboxBackend | null;
    // some project runs openshell, asked often, so cheap
    openshell(): boolean;
    // how many projects pick each backend of their own, for the page
    counts(): Record<SandboxBackend, number>;
  };
};

export type Sandbox = {
  store: SandboxStore;
  routes: RouteDescriptor[];
  // the shell of a project's next command: the sandbox's when its
  // backend is openshell and the gateway is set up; without a project,
  // the instance's
  shell(builtin: ShellBackend, projectId?: string | null): ShellBackend;
  // the network a command in a sandbox runs under
  net(): SandboxNet;
  // the current gateway's leases, null while no backend asks for it
  // and none is left to sweep
  leases(): Leases | null;
  // at start: the leases made and an earlier process's sandboxes swept
  start(): Promise<void>;
  // the limits were saved: a command at the cap and the warm pool look
  // again
  poke(): void;
  // a project's backend changed or a project went: an unwanted manager
  // lets its warm pool empty, or goes once it holds nothing
  projectsChanged(): void;
  // timers stopped and the bus left; sandboxes stay for the next sweep
  close(): void;
  // every command's put-back after its commit ended, for a test
  idle(): Promise<void>;
};

export function sandboxArea(deps: SandboxDeps): Sandbox {
  const store = new SandboxStore(deps.db);
  let running = false;
  let current: {
    key: string;
    leases: Leases;
    gateway: Gateway;
    unsubscribe(): void;
    // its start sweep, once the area started
    started: Promise<void> | null;
    // a sweep of it listed every kind, so no leftover is unknown
    swept: boolean;
  } | null = null;
  // managers the settings moved off, each deleting its sandboxes as
  // their commands end; its client closes once every delete ended
  let retired: { leases: Leases; gateway: Gateway }[] = [];
  // one attach or sweep at a time per provider, across managers
  const locks = new Map<string, Promise<unknown>>();

  const keys = (): Record<SandboxKeyRole, string | null> => ({
    ca: deps.secret(SANDBOX_KEYS.ca),
    cert: deps.secret(SANDBOX_KEYS.cert),
    key: deps.secret(SANDBOX_KEYS.key),
  });
  // the gateway the settings name, whatever backend the instance picks,
  // since a project may pick openshell over a builtin instance; null
  // without an endpoint or a key file
  const config = (): (GatewayConfig & { image: string }) | null => {
    const held = store.settings();
    if (held.endpoint === null) return null;
    const { ca, cert, key } = keys();
    if (ca === null || cert === null || key === null) return null;
    const image = held.image ?? defaultImage(deps.version);
    return { endpoint: held.endpoint, ca, cert, key, image };
  };
  // a project's backend, its own over the instance's
  const backendOf = (projectId?: string | null): SandboxBackend =>
    (projectId ? deps.projects.backend(projectId) : null) ??
    store.settings().backend;
  // the instance or some project runs openshell
  const wanted = (): boolean =>
    store.settings().backend === "openshell" || deps.projects.openshell();
  const drop = () => {
    if (current === null) return;
    const { leases, gateway } = current;
    current.unsubscribe();
    current = null;
    retired.push({ leases, gateway });
    void leases.drain().then(() => {
      gateway.close();
      retired = retired.filter((old) => old.leases !== leases);
    });
  };
  // nothing runs openshell: an empty manager goes, and its warm pool
  // empties, so the last idle sandbox's delete lets it go. Never a drain
  // of a held or idle sandbox, which only a settings save does
  // A manager whose sweeps never listed everything stays, so its probe
  // sweeps what an earlier run left once the gateway answers.
  const tidy = () => {
    if (current === null || !current.swept || wanted()) return;
    if (current.leases.rows().length === 0) drop();
    else current.leases.poke();
  };
  // the leases of the gateway the settings name, made only when create
  // asks: a new endpoint, key or image deletes every sandbox of the old
  // one, and so does a key file gone. One manager serves every project,
  // so a project's change never makes one
  const ensure = (create: boolean, next = config()): Leases | null => {
    const key = next === null ? "" : JSON.stringify(next);
    if (current !== null && current.key === key) return current.leases;
    drop();
    if (next === null || !create) return null;
    const { image, ...reach } = next;
    const gateway = deps.connect(reach);
    const leases = new Leases({
      clock: deps.clock,
      log: deps.log,
      gateway,
      instanceId: store.settings().instanceId,
      image,
      // no warm sandbox while nothing runs openshell
      limits: () =>
        wanted() ? deps.limits() : { ...deps.limits(), sandboxWarm: 0 },
      repos: deps.repos,
      // every other manager, the replacement included once this retires
      others: () => [
        ...retired.map((old) => old.leases),
        ...(current === null ? [] : [current.leases]),
      ],
      // a retired manager's delete frees room under the instance's cap;
      // this one's last delete may leave it unwanted and empty
      freed: () => {
        current?.leases.poke();
        queueMicrotask(tidy);
      },
      locks,
      net: () => sandboxNet(store.settings()),
      listed: () => {
        if (current?.leases !== leases || current.swept) return;
        current.swept = true;
        queueMicrotask(tidy);
      },
    });
    const unsubscribe = subscribe((event) => {
      for (const { sessionId, reason } of recyclesOf(event)) {
        leases.recycleSession(sessionId, reason);
      }
    }, deps.log);
    current = {
      key,
      leases,
      gateway,
      unsubscribe,
      started: running ? leases.start() : null,
      swept: false,
    };
    return leases;
  };

  const commands = sandboxBackend({
    clock: deps.clock,
    log: deps.log,
    limits: deps.limits,
  });
  const backend: ShellBackend = {
    ownTmp: true,
    sandboxTimeout: true,
    ownExits: true,
    sharedWithSubagents: true,
    atOnce: true,
    acquire(call, deadline, signal) {
      const leases = ensure(true);
      if (leases === null) throw new Error("the sandbox shell is not set up");
      return leases.acquire(call, deadline, signal);
    },
    run: (job, context, hooks, stops) =>
      commands.run(job, context, hooks, stops),
  };

  const answer = (): SandboxResponse => {
    const settings = store.settings();
    const held = keys();
    return {
      settings,
      defaultImage: defaultImage(deps.version),
      gatewayLabel: gatewayLabel(settings.instanceId),
      keys: {
        ca: held.ca !== null,
        cert: held.cert !== null,
        key: held.key !== null,
      },
      active: store.settings().backend === "openshell" && config() !== null,
      overrides: deps.projects.counts(),
    };
  };

  return {
    store,
    routes: routes({
      store,
      clock: deps.clock,
      log: deps.log,
      answer,
      leases: () => ({
        leases: [
          ...retired.flatMap((old) => old.leases.rows()),
          ...(current?.leases.rows() ?? []),
        ],
        refused: current?.leases.refused() ?? null,
      }),
      // a save while nothing runs openshell drains the sandboxes, but a
      // manager that never listed stays for its probe, and a new gateway
      // gets one whose start sweep takes what an earlier run left
      saved: () => {
        if (wanted()) return void ensure(true);
        const next = config();
        const key = next === null ? "" : JSON.stringify(next);
        if (current === null) return;
        if (current.key === key) {
          if (current.swept) drop();
          return;
        }
        drop();
        if (next !== null) ensure(true, next);
      },
    }),
    shell: (builtin, projectId) => {
      const next = config();
      // a key file gone still retires the old manager
      if (next === null) {
        ensure(false, next);
        return builtin;
      }
      if (backendOf(projectId) !== "openshell") {
        tidy();
        return builtin;
      }
      return ensure(true, next) === null ? builtin : backend;
    },
    net: () => sandboxNet(store.settings()),
    leases: () => ensure(wanted()),
    async start() {
      running = true;
      // a saved gateway is swept even while nothing runs openshell, since
      // an earlier run may have left a project's sandboxes there
      ensure(true);
      if (current === null) return;
      current.started ??= current.leases.start();
      await current.started;
      tidy();
    },
    poke: () => current?.leases.poke(),
    // a project back on openshell refills a pool emptied meanwhile
    projectsChanged: () => {
      if (wanted()) current?.leases.poke();
      else tidy();
    },
    idle: () => commands.idle(),
    close() {
      running = false;
      for (const old of retired) {
        old.leases.close();
        old.gateway.close();
      }
      retired = [];
      if (current === null) return;
      current.unsubscribe();
      current.leases.close();
      current.gateway.close();
      current = null;
    },
  };
}
