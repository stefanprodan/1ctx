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
import { errorFields, type Log } from "../lib/log.ts";
import { type ProjectRow, visible } from "../projects/index.ts";
import { type Event, type PreparedRun, RunCapacity } from "../runner/index.ts";
import type { SessionStore, UsagePort } from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import { nextFire } from "./schedule.ts";
import type { AutomationStore } from "./store.ts";
import { replaceMissed, type Waiting, Waits } from "./waits.ts";

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
  start(): number;
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
  const waits = new Waits(deps.log);
  let passAt = 0;

  const wake = () => {
    waits.wake();
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
  ): Started | null => {
    const holder: { value: PreparedRun | null } = { value: null };
    const recorded: {
      value:
        | { msg: "fire"; user: string }
        | { msg: "skip"; reason: string }
        | null;
    } = { value: null };
    try {
      const result = transact<Started | null>(deps.db, () => {
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
        // a manual start takes a fire left waiting for a slot
        const waiting =
          row.suspendedAt === null && row.nextAt !== null && row.nextAt <= now;
        const nextAt =
          source === "schedule" || waiting
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
          recorded.value = { msg: "fire", user: resolved.user.username };
          return {
            result: { detail: prepared.detail, launch: prepared.launch },
            events: [changed(updated)],
          };
        } catch (err) {
          holder.value?.abandon();
          holder.value = null;
          if (source === "manual" || !(err instanceof HttpError)) throw err;
          // a full run pool writes nothing: the row stays due
          if (err instanceof RunCapacity) {
            return {
              result: { wait: err.pool, dueAt: dueAt!, ownerId: row.ownerId },
            };
          }
          const updated = deps.store.recordEvent(row.id, {
            at: now,
            dueAt: dueAt!,
            source,
            outcome: "skipped",
            reason: err.message,
            nextAt,
          })!;
          recorded.value = { msg: "skip", reason: err.message };
          return { result: null, events: [changed(updated)] };
        }
      });
      if (recorded.value?.msg === "fire") {
        deps.log.info("fire", {
          automation: id,
          source,
          user: recorded.value.user,
        });
      } else if (recorded.value?.msg === "skip") {
        deps.log.info("skip", {
          automation: id,
          reason: recorded.value.reason,
        });
      }
      return result;
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
      deps.log.error("skip record failed", {
        automation: id,
        ...errorFields(writeError),
      });
    }
  };

  const fire = async (id: string): Promise<SessionDetail | null> => {
    const seen = waits.generation;
    try {
      const result = start(id, "schedule", null);
      if (result === null) return null;
      if ("wait" in result) {
        waits.block(id, result, seen);
        return null;
      }
      waits.started(id);
      result.launch();
      return result.detail;
    } catch (err) {
      recordUnexpected(id, err);
      deps.log.error("fire failed", {
        automation: id,
        ...errorFields(err),
      });
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
        deps.log.warn("retention delete failed", {
          chat: session.id,
          ...errorFields(err, false),
        });
      }
    }
    if (count > 0) deps.log.info("retention", { removed: count });
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
      deps.log.error("run record failed", {
        automation: session.automationId,
        ...errorFields(err),
      });
    }
  };

  const pass = async (keepGoing: () => boolean = () => true): Promise<void> => {
    const now = deps.clock();
    passAt = now;
    for (const row of deps.store.due(now)) {
      if (!keepGoing()) return;
      replaceMissed(deps, row.id, now);
    }
    // oldest first, due and waiting alike; a full pool for one owner
    // passes over that owner's rows, for the process it ends the fires
    for (const row of deps.store.due(now)) {
      if (!keepGoing() || waits.processFull) break;
      if (waits.ownerFull(row.ownerId)) continue;
      await fire(row.id);
    }
    if (!keepGoing()) return;
    if (now - lastSweep >= SWEEP_MS) {
      try {
        sweep();
        lastSweep = now;
      } catch (err) {
        deps.log.warn("retention failed", errorFields(err, false));
      }
    }
  };

  const wait = async (seen: number): Promise<void> => {
    if (waits.generation !== seen) return;
    const now = deps.clock();
    // while a pool is full the rows left due are waits, not wakes
    const earliest = deps.store.earliest(waits.any ? passAt : null);
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
      const seen = waits.generation;
      await pass(() => running);
      if (running) await wait(seen);
    }
  };

  return {
    start() {
      if (running) return 0;
      running = true;
      const reconciled = reconcile();
      unsubscribe ??= subscribe(onSession, deps.log);
      void loop().catch((err) =>
        deps.log.error("scheduler stopped", errorFields(err)),
      );
      return reconciled;
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
      if (result === null || "wait" in result) {
        throw new Conflict("no such automation");
      }
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

type Started = { detail: SessionDetail; launch: () => void } | Waiting;

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
