// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
import type { EventSource } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import { type Db, transact } from "../db/index.ts";
import { type BusEvent, subscribe } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, Conflict, HttpError } from "../lib/errors.ts";
import type { Log } from "../lib/log.ts";
import { type ProjectRow, visible } from "../projects/index.ts";
import type { Event, PreparedRun } from "../runner/index.ts";
import type { SessionStore, UsagePort } from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import { nextFire } from "./schedule.ts";
import type { AutomationStore } from "./store.ts";

const PASS_MS = 60_000;
const SWEEP_MS = 3_600_000;

type Deps = {
  db: Db;
  clock: Clock;
  log: Log;
  store: AutomationStore;
  users: { byId(id: string): UserRow | null };
  projects: {
    byId(id: string): ProjectRow | null;
    isMember(projectId: string, userId: string): boolean;
  };
  agents: { byId(id: string): AgentRow | null };
  sessions: SessionStore;
  usage: UsagePort;
  runner: { startRun(event: Event): PreparedRun };
};

export type Scheduler = {
  start(): void;
  stop(): void;
  wake(): void;
  pass(): Promise<void>;
  fire(id: string): Promise<SessionDetail | null>;
  runNow(row: AutomationSummary, user: UserRow): SessionDetail;
  sweep(): number;
  reconcile(): number;
  dispose(): void;
};

export function scheduler(deps: Deps): Scheduler {
  let running = false;
  let wakeWait: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let lastSweep = deps.clock();

  const wake = () => {
    const resolve = wakeWait;
    wakeWait = null;
    resolve?.();
  };

  const changed = (automation: AutomationSummary) => ({
    type: "automation.changed" as const,
    data: { projectId: automation.projectId, automation },
  });

  const ownerFor = (
    row: AutomationSummary,
  ): {
    user: UserRow;
    project: ProjectRow;
    agent: AgentRow;
  } => {
    const user = deps.users.byId(row.ownerId);
    if (user === null || user.disabled) throw new Conflict("owner unavailable");
    const project = deps.projects.byId(row.projectId);
    if (
      project === null ||
      !visible(
        project,
        { userId: user.id, role: user.role },
        deps.projects.isMember(project.id, user.id),
      )
    ) {
      throw new Conflict("owner cannot see project");
    }
    const agent = deps.agents.byId(row.agentId);
    if (agent === null) throw new Conflict("no such agent");
    return { user, project, agent };
  };

  const manualFor = (
    row: AutomationSummary,
    actor: UserRow | null,
  ): { user: UserRow; project: ProjectRow; agent: AgentRow } => {
    if (actor === null) throw new BadRequest("the user is gone");
    const project = deps.projects.byId(row.projectId);
    if (project === null) throw new Conflict("no such automation");
    const agent = deps.agents.byId(row.agentId);
    if (agent === null) throw new BadRequest("no such agent");
    return { user: actor, project, agent };
  };

  const eventFor = (
    row: AutomationSummary,
    source: EventSource,
    dueAt: number,
    receivedAt: number,
    user: UserRow,
    project: ProjectRow,
    agent: AgentRow,
  ): Event => ({
    source,
    automation: {
      id: row.id,
      name: row.name,
      tz: row.tz,
      projectMemory: row.projectMemory,
      ownMemory: row.ownMemory,
      memoryGuidance: row.memoryGuidance,
      disabledCapabilities: row.disabledCapabilities,
    },
    instructions: row.instructions,
    dueAt,
    receivedAt,
    key: null,
    deadlineMs: row.deadlineMs,
    user,
    project,
    agent,
  });

  const start = (
    id: string,
    source: EventSource,
    actor: UserRow | null,
  ): { detail: SessionDetail; launch: () => void } | null => {
    const holder: { value: PreparedRun | null } = { value: null };
    try {
      return transact(deps.db, () => {
        const row = deps.store.byId(id);
        if (row === null) {
          if (source === "manual") throw new Conflict("no such automation");
          return { result: null };
        }
        const now = deps.clock();
        const dueAt = source === "schedule" ? row.nextAt : now;
        if (
          source === "schedule" &&
          (row.suspendedAt !== null || dueAt === null || dueAt > now)
        ) {
          return { result: null };
        }
        const nextAt =
          source === "schedule"
            ? nextFire(row.schedule, row.tz, now)
            : undefined;
        try {
          const resolved =
            source === "schedule" ? ownerFor(row) : manualFor(row, actor);
          if (deps.sessions.runningAutomation(row.id)) {
            throw new Conflict("still running");
          }
          holder.value = deps.runner.startRun(
            eventFor(
              row,
              source,
              dueAt!,
              now,
              resolved.user,
              resolved.project,
              resolved.agent,
            ),
          );
          const prepared = holder.value;
          const updated = deps.store.recordEvent(row.id, {
            at: now,
            dueAt: dueAt!,
            source,
            outcome: "run",
            reason: null,
            nextAt,
            runSessionId: prepared.detail.session.id,
          })!;
          return {
            result: { detail: prepared.detail, launch: prepared.launch },
            events: [changed(updated)],
          };
        } catch (err) {
          holder.value?.abandon();
          holder.value = null;
          if (source === "manual" || !(err instanceof HttpError)) throw err;
          const updated = deps.store.recordEvent(row.id, {
            at: now,
            dueAt: dueAt!,
            source,
            outcome: "skipped",
            reason: err.message,
            nextAt,
          })!;
          return { result: null, events: [changed(updated)] };
        }
      });
    } catch (err) {
      holder.value?.abandon();
      throw err;
    }
  };

  const recordUnexpected = (id: string, error: unknown): void => {
    try {
      transact(deps.db, () => {
        const row = deps.store.byId(id);
        if (row === null || row.suspendedAt !== null || row.nextAt === null) {
          return { result: undefined };
        }
        const now = deps.clock();
        const updated = deps.store.recordEvent(row.id, {
          at: now,
          dueAt: row.nextAt,
          source: "schedule",
          outcome: "skipped",
          reason: errText(error),
          nextAt: nextFire(row.schedule, row.tz, now),
        })!;
        return { result: undefined, events: [changed(updated)] };
      });
    } catch (writeError) {
      deps.log(
        `automation ${id} could not record a skipped event: ${String(writeError)}`,
      );
    }
  };

  const fire = async (id: string): Promise<SessionDetail | null> => {
    try {
      const result = start(id, "schedule", null);
      result?.launch();
      return result?.detail ?? null;
    } catch (err) {
      recordUnexpected(id, err);
      deps.log(`automation ${id} failed to fire: ${String(err)}`);
      return null;
    }
  };

  const sweep = (): number => {
    let count = 0;
    for (const session of deps.sessions.expiredRuns(deps.clock())) {
      try {
        transact(deps.db, () => {
          const current = deps.sessions.byId(session.id);
          if (current === null || current.status === "running") {
            return { result: undefined };
          }
          deps.usage.deleteSession(current.id);
          deps.sessions.delete(current.id);
          count++;
          return {
            result: undefined,
            events: [
              {
                type: "session.deleted" as const,
                data: { projectId: current.projectId, sessionId: current.id },
              },
            ],
          };
        });
      } catch (err) {
        deps.log(
          `automation run ${session.id} could not be swept: ${String(err)}`,
        );
      }
    }
    return count;
  };

  const reconcile = (): number => {
    let count = 0;
    for (const row of deps.store.all()) {
      if (row.lastRunSessionId === null) continue;
      const session = deps.sessions.byId(row.lastRunSessionId);
      if (session === null || session.status === "running") continue;
      transact(deps.db, () => {
        const updated = deps.store.recordRunEnd(
          row.id,
          session.id,
          session.status,
          deps.clock(),
        );
        if (updated === null) return { result: undefined };
        count++;
        return { result: undefined, events: [changed(updated)] };
      });
    }
    return count;
  };

  const onSession = (event: BusEvent) => {
    if (event.type !== "session.changed") return;
    const session = event.data.session;
    if (session.automationId === null || session.status === "running") return;
    try {
      transact(deps.db, () => {
        const updated = deps.store.recordRunEnd(
          session.automationId!,
          session.id,
          session.status,
          deps.clock(),
        );
        return {
          result: undefined,
          events: updated === null ? [] : [changed(updated)],
        };
      });
    } catch (err) {
      deps.log(
        `automation ${session.automationId} could not record its run: ${String(err)}`,
      );
    }
  };

  const pass = async (keepGoing: () => boolean = () => true): Promise<void> => {
    const now = deps.clock();
    for (const row of deps.store.due(now)) {
      if (!keepGoing()) return;
      await fire(row.id);
    }
    if (!keepGoing()) return;
    if (now - lastSweep >= SWEEP_MS) {
      try {
        sweep();
        lastSweep = now;
      } catch (err) {
        deps.log(`automation retention sweep failed: ${String(err)}`);
      }
    }
  };

  const wait = async (): Promise<void> => {
    const now = deps.clock();
    const earliest = deps.store.earliest();
    const ms = earliest === null ? PASS_MS : Math.min(PASS_MS, earliest - now);
    if (ms <= 0) return;
    const sleeper =
      deps.clock.sleep?.(ms) ??
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    const waking = new Promise<void>((resolve) => {
      wakeWait = resolve;
    });
    await Promise.race([sleeper, waking]);
    wakeWait = null;
  };

  const loop = async () => {
    while (running) {
      await pass(() => running);
      if (running) await wait();
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      reconcile();
      unsubscribe ??= subscribe(onSession);
      void loop().catch((err) => deps.log(`scheduler stopped: ${String(err)}`));
    },
    stop() {
      running = false;
      wake();
    },
    wake,
    pass,
    fire,
    runNow(row, user) {
      const result = start(row.id, "manual", user);
      if (result === null) throw new Conflict("no such automation");
      result.launch();
      return result.detail;
    },
    sweep,
    reconcile,
    dispose() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
