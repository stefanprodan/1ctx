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
import { type AccessPort, routes } from "./routes.ts";
import { type Scheduler, scheduler } from "./scheduler.ts";
import { AutomationStore } from "./store.ts";

export { type AccessPort, type RoutesDeps, routes } from "./routes.ts";
export {
  checkSchedule,
  MIN_GAP_MINUTES,
  nextFire,
  nextFires,
} from "./schedule.ts";
export { type Scheduler, scheduler } from "./scheduler.ts";
export {
  type AutomationFields,
  AutomationStore,
  MAX_AUTOMATIONS_PER_PROJECT,
} from "./store.ts";

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
};

export type Automations = {
  store: AutomationStore;
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
  return {
    store,
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
    routes: routes({ ...deps, store, scheduler: scheduled }),
  };
}
