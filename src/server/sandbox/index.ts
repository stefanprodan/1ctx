// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sandbox shell: bash's commands in an OpenShell sandbox per chat,
// its subagents' included, when an admin picks it and the gateway is set up. The
// area keeps the settings row, one gateway's leases at a time, and the
// ShellBackend bash asks for at each command.

import type { SandboxResponse } from "../../shared/api/sandbox.ts";
import {
  SANDBOX_KEYS,
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
};

export type Sandbox = {
  store: SandboxStore;
  routes: RouteDescriptor[];
  // the shell of the next command: the sandbox's when it is on
  shell(builtin: ShellBackend): ShellBackend;
  // the settings and every key file in place
  active(): boolean;
  // the network a command in a sandbox runs under
  net(): SandboxNet;
  // the current gateway's leases, null while the shell is off
  leases(): Leases | null;
  // at start: the leases made and an earlier process's sandboxes swept
  start(): Promise<void>;
  // the limits were saved: a command at the cap and the warm pool look
  // again
  poke(): void;
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
  // what the next command runs on, null while the shell is off
  const config = (): (GatewayConfig & { image: string }) | null => {
    const held = store.settings();
    if (held.shell !== "sandbox" || held.endpoint === null) return null;
    const { ca, cert, key } = keys();
    if (ca === null || cert === null || key === null) return null;
    const image = held.image ?? defaultImage(deps.version);
    return { endpoint: held.endpoint, ca, cert, key, image };
  };
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
  // the leases of the gateway the settings name: a new endpoint, key or
  // image deletes every sandbox of the old one
  const ensure = (): Leases | null => {
    const next = config();
    const key = next === null ? "" : JSON.stringify(next);
    if (current !== null && current.key === key) return current.leases;
    drop();
    if (next === null) return null;
    const { image, ...reach } = next;
    const gateway = deps.connect(reach);
    const leases = new Leases({
      clock: deps.clock,
      log: deps.log,
      gateway,
      instanceId: store.settings().instanceId,
      image,
      limits: deps.limits,
      repos: deps.repos,
      // every other manager, the replacement included once this retires
      others: () => [
        ...retired.map((old) => old.leases),
        ...(current === null ? [] : [current.leases]),
      ],
      // a retired manager's delete frees room under the instance's cap
      freed: () => current?.leases.poke(),
      locks,
      net: () => sandboxNet(store.settings()),
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
      const leases = ensure();
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
      active: config() !== null,
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
      saved: () => void ensure(),
    }),
    shell: (builtin) => (ensure() === null ? builtin : backend),
    active: () => config() !== null,
    net: () => sandboxNet(store.settings()),
    leases: () => ensure(),
    async start() {
      running = true;
      ensure();
      if (current === null) return;
      current.started ??= current.leases.start();
      await current.started;
    },
    poke: () => current?.leases.poke(),
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
