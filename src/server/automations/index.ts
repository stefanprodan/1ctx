// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentRow } from "../agents/index.ts";
import type { Db } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import type { Limits } from "../limits/index.ts";
import type { MemoryCapability } from "../memory/index.ts";
import type { ProjectRow } from "../projects/index.ts";
import type { Event, PreparedRun } from "../runner/index.ts";
import type { SessionStore } from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import { type Alerts, alerts } from "./alerts.ts";
import { type AccessPort, routes } from "./routes.ts";
import { type Scheduler, scheduler } from "./scheduler.ts";
import { AutomationStore } from "./store.ts";

export { checkSchedule, nextFire, nextFires } from "./schedule.ts";

export type AutomationsDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  access: AccessPort;
  users: { byId(id: string): UserRow | null };
  projects: {
    byId(id: string): ProjectRow | null;
    isMember(projectId: string, userId: string): boolean;
  };
  agents: { byId(id: string): AgentRow | null };
  limits: { current(): Limits };
  memory: Pick<MemoryCapability, "read" | "save" | "undo">;
  sessions: SessionStore;
  runner: { startRun(event: Event): PreparedRun };
  // the run-attention decision is on with a decider to ask; off when
  // absent
  deciderOn?: () => boolean;
  // the decider's chance on a run, in the caller's transaction
  markAttention(sessionId: string, attention: number, by: string): boolean;
};

export type Automations = {
  store: AutomationStore;
  // the open alert: a run's end, a decider's word, a dismiss
  alerts: Alerts;
  scheduler: Scheduler;
  // in the caller's transaction: the agent's active automations
  // suspended by the admin who deleted it, and an envelope for every one
  // of its automations, so a run held on a feed learns the agent is gone
  suspendAgent(agentId: string, by: string, now: number): BusEvent[];
  start(): number;
  drain(): void;
  stop(): void;
  dispose(): void;
  routes: RouteDescriptor[];
};

export function automationsArea(deps: AutomationsDeps): Automations {
  const store = new AutomationStore(deps.db);
  const scheduled = scheduler({ ...deps, store });
  store.setWake(scheduled.wake);
  const alerted = alerts({
    db: deps.db,
    store,
    sessions: deps.sessions,
    markAttention: deps.markAttention,
  });
  return {
    store,
    alerts: alerted,
    scheduler: scheduled,
    suspendAgent: (agentId, by, now) =>
      store.retireAgent(agentId, by, now).map((row) => ({
        type: "automation.changed" as const,
        data: { projectId: row.projectId, automation: row },
      })),
    start: scheduled.start,
    drain: scheduled.drain,
    stop: scheduled.stop,
    dispose: scheduled.dispose,
    routes: routes({
      ...deps,
      store,
      scheduler: scheduled,
      deciderOn: deps.deciderOn ?? (() => false),
      alerts: alerted,
    }),
  };
}
