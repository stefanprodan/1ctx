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
import type { DeletedRun, SessionStore } from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import { type AlertEmailDeps, alertEmails } from "./alert-email.ts";
import { type Alerts, alerts } from "./alerts.ts";
import { type AccessPort, routes } from "./routes.ts";
import { type Scheduler, scheduler } from "./scheduler.ts";
import { AutomationStore, automationChanged } from "./store.ts";

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
  // the run-attention decision is on with a decider to ask
  deciderOn(): boolean;
  // the decider's chance on a run, in the caller's transaction
  markAttention(sessionId: string, attention: number, by: string): boolean;
  // the owner's email when an alert opens; none emails nobody
  email?: Pick<AlertEmailDeps, "outbox" | "canOpen">;
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
  // in the caller's transaction, after one of its runs was deleted: the
  // open alert, and the revision when the row named the run, whose link
  // the foreign key cleared
  runDeleted(run: DeletedRun): BusEvent[];
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
    emails:
      deps.email &&
      alertEmails({
        ...deps.email,
        clock: deps.clock,
        log: deps.log,
        users: deps.users,
        projects: deps.projects,
        reason: (sessionId) =>
          deps.sessions.byId(sessionId)?.attentionReason ?? null,
      }),
  });
  return {
    store,
    alerts: alerted,
    scheduler: scheduled,
    suspendAgent: (agentId, by, now) =>
      store.retireAgent(agentId, by, now).map(automationChanged),
    runDeleted(run) {
      const events = run.marked
        ? alerted.pruned(run.automationId, run.endedAt)
        : [];
      // the alert's change moved the revision and read the row after
      // the delete, so it carries the cleared link too
      if (!run.named || events.length > 0) return events;
      const row = store.touch(run.automationId);
      return row === null ? events : [automationChanged(row)];
    },
    start: scheduled.start,
    drain: scheduled.drain,
    stop: scheduled.stop,
    dispose: scheduled.dispose,
    routes: routes({
      ...deps,
      store,
      scheduler: scheduled,
      alerts: alerted,
    }),
  };
}
