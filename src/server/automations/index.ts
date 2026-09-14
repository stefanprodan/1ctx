// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentRow } from "../agents/index.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import type { Limits } from "../limits/index.ts";
import type { ProjectRow } from "../projects/index.ts";
import type { Event, PreparedRun } from "../runner/index.ts";
import type { SessionStore, UsagePort } from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import { type AccessPort, routes } from "./routes.ts";
import { type Scheduler, scheduler } from "./scheduler.ts";
import { AutomationStore } from "./store.ts";

export { type AccessPort, type RoutesDeps, routes } from "./routes.ts";
export { checkSchedule, MIN_GAP_MINUTES, nextFire } from "./schedule.ts";
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
  sessions: SessionStore;
  usage: UsagePort;
  runner: { startRun(event: Event): PreparedRun };
};

export type Automations = {
  store: AutomationStore;
  scheduler: Scheduler;
  usesAgent(agentId: string): boolean;
  start(): void;
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
    usesAgent: (agentId) => store.usesAgent(agentId),
    start: scheduled.start,
    stop: scheduled.stop,
    dispose: scheduled.dispose,
    routes: routes({ ...deps, store, scheduler: scheduled }),
  };
}
