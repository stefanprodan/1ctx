// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
import { DEFERRED_BY_RESTART, type EventSource } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import { type Db, transact } from "../db/index.ts";
import { type BusEvent, subscribe } from "../lib/bus.ts";
import { type Clock, HOUR_MS, MINUTE_MS, sleep } from "../lib/clock.ts";
import { BadRequest, Conflict, HttpError, messageOf } from "../lib/errors.ts";
import { errorFields, type Log } from "../lib/log.ts";
import { type ProjectRow, visible } from "../projects/index.ts";
import { type Event, type PreparedRun, RunCapacity } from "../runner/index.ts";
import type { SessionStore } from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import { recordOn } from "./events.ts";
import { type Cut, cutRuns, deferDue, stillCut, withCut } from "./refire.ts";
import { nextFire } from "./schedule.ts";
import { type AutomationStore, automationChanged, RETIRED } from "./store.ts";
import { replaceMissed, type Waiting, Waits } from "./waits.ts";

const PASS_MS = MINUTE_MS;
const SWEEP_MS = HOUR_MS;

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
  runner: { startRun(event: Event): PreparedRun };
};

export type Scheduler = {
  start(): number;
  // from the first signal: nothing fires, what comes due is deferred
  drain(): void;
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
  let draining = false;
  let wakeWait: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let lastSweep = deps.clock();
  const waits = new Waits(deps.log);
  let passAt = 0;
  // the runs a restart cut, listed at start and fired by the pass
  let cut = new Map<string, Cut>();

  const wake = () => {
    waits.wake();
    const resolve = wakeWait;
    wakeWait = null;
    resolve?.();
  };

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
    actor: UserRow,
  ): { user: UserRow; project: ProjectRow; agent: AgentRow } => {
    const project = deps.projects.byId(row.projectId);
    if (project === null) throw new Conflict("no such automation");
    if (row.agentRetired) throw new Conflict(RETIRED);
    const agent = deps.agents.byId(row.agentId);
    if (agent === null) throw new BadRequest("no such agent");
    return { user: actor, project, agent };
  };

  const eventFor = (
    row: AutomationSummary,
    source: EventSource,
    dueAt: number,
    resolved: Pick<Event, "user" | "project" | "agent">,
  ): Event => ({
    source,
    automation: {
      id: row.id,
      name: row.name,
      tz: row.tz,
      ownMemory: row.ownMemory,
      memoryGuidance: row.memoryGuidance,
      attentionMode: row.attentionMode,
      attentionGuidance: row.attentionGuidance,
      disabledCapabilities: row.disabledCapabilities,
    },
    instructions: row.instructions,
    dueAt,
    deadlineMs: row.deadlineMs,
    ...resolved,
  });

  // one try at a fire; actor is the user of a manual one, else null
  const attempt = (
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
        const listed = source === "restart" ? cut.get(id) : undefined;
        const dueAt =
          source === "schedule" ? row.nextAt : (listed?.listedAt ?? now);
        if (
          source === "schedule" &&
          (row.suspendedAt !== null || dueAt === null || dueAt > now)
        ) {
          return { result: null };
        }
        if (source === "restart" && !stillCut(row, listed)) {
          return { result: null };
        }
        // a manual start takes a fire left waiting for a place
        const waiting =
          row.suspendedAt === null && row.nextAt !== null && row.nextAt <= now;
        const nextAt =
          source === "schedule" || waiting
            ? nextFire(row.schedule, row.tz, now)
            : undefined;
        try {
          const resolved =
            actor === null ? ownerFor(row) : manualFor(row, actor);
          if (deps.sessions.runningAutomation(row.id)) {
            throw new Conflict("still running");
          }
          holder.value = deps.runner.startRun(
            eventFor(row, source, dueAt!, resolved),
          );
          const prepared = holder.value;
          const recordedRun = deps.store.recordEvent(row.id, {
            at: now,
            dueAt: dueAt!,
            source,
            outcome: "run",
            reason:
              source !== "manual" &&
              waiting &&
              row.lastEventOutcome === "deferred" &&
              row.lastEventDueAt === row.nextAt
                ? DEFERRED_BY_RESTART
                : null,
            nextAt,
            runSessionId: prepared.detail.session.id,
          })!;
          // a run that took a due fire spends a once task, after its
          // event: the table holds next_at null exactly while suspended
          const updated =
            row.once && nextAt !== undefined
              ? deps.store.spendOnce(row.id, now)!
              : recordedRun;
          recorded.value = { msg: "fire", user: resolved.user.username };
          return {
            result: { detail: prepared.detail, launch: prepared.launch },
            events: [automationChanged(updated)],
          };
        } catch (err) {
          holder.value?.abandon();
          holder.value = null;
          if (source === "manual" || !(err instanceof HttpError)) throw err;
          // a full cap writes nothing: the row stays due
          if (err instanceof RunCapacity) {
            return {
              result: {
                wait: err.cap,
                dueAt: dueAt!,
                projectId: row.projectId,
              },
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
          return { result: null, events: [automationChanged(updated)] };
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
    recordOn(deps, id, "skip record failed", (row, dueAt) => {
      const now = deps.clock();
      return {
        at: now,
        dueAt,
        source: "schedule",
        outcome: "skipped",
        reason: messageOf(error),
        nextAt: nextFire(row.schedule, row.tz, now),
      };
    });
  };

  const fire = async (id: string): Promise<SessionDetail | null> => {
    if (draining) {
      deferDue(deps, id, deps.clock());
      return null;
    }
    const seen = waits.generation;
    const source = cut.has(id) ? "restart" : "schedule";
    try {
      const result = attempt(id, source, null);
      if (result !== null && "wait" in result) {
        waits.block(id, result, seen, deps.clock());
        return null;
      }
      cut.delete(id);
      if (result === null) return null;
      waits.started(id);
      result.launch();
      return result.detail;
    } catch (err) {
      // a restart run's failure leaves a due fire to the next pass
      if (!cut.delete(id)) recordUnexpected(id, err);
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
          const deleted = deps.sessions.remove(session.id);
          if (deleted === null || deleted === "running") {
            return { result: undefined };
          }
          count++;
          return { result: undefined, events: [deleted] };
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
        return { result: undefined, events: [automationChanged(updated)] };
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
          events: updated === null ? [] : [automationChanged(updated)],
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
    const due = deps.store.due(now);
    if (draining) {
      for (const row of due) {
        if (!keepGoing()) return;
        deferDue(deps, row.id, now);
      }
      return;
    }
    waits.prune(new Set([...due.map((row) => row.id), ...cut.keys()]));
    for (const row of due) {
      if (!keepGoing()) return;
      replaceMissed(deps, row.id, now);
    }
    // oldest first, due and waiting alike, then the cut runs; a full
    // project passes over its rows, a full process ends the fires
    for (const row of withCut(deps.store.due(now), cut, deps.store)) {
      if (!keepGoing() || waits.processFull) break;
      if (waits.projectFull(row.projectId)) continue;
      await fire(row.id);
      // a fire is synchronous, so a burst must not hold every request
      await new Promise<void>((resolve) => setImmediate(resolve));
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
    // while a cap is full the rows left due are waits, not wakes
    const earliest = deps.store.earliest(waits.any || draining ? passAt : null);
    const ms = earliest === null ? PASS_MS : Math.min(PASS_MS, earliest - now);
    if (ms <= 0) return;
    const sleeper = sleep(deps.clock, ms).promise;
    const waking = new Promise<boolean>((resolve) => {
      wakeWait = () => resolve(true);
    });
    // left for wake() to clear: a loop started since may have set its own
    const woken = await Promise.race([sleeper.then(() => false), waking]);
    if (!woken) waits.expire(deps.clock(), PASS_MS);
  };

  let epoch = 0; // a stop and a start mid-pass leave one loop, not two
  const loop = async (mine: number) => {
    const live = () => running && epoch === mine;
    while (live()) {
      const seen = waits.generation;
      await pass(live);
      if (live()) await wait(seen);
    }
  };

  return {
    start() {
      if (running) return 0;
      running = true;
      const reconciled = reconcile();
      cut = cutRuns(deps, deps.clock());
      unsubscribe ??= subscribe(onSession, deps.log);
      void loop(++epoch).catch((err) =>
        deps.log.error("scheduler stopped", errorFields(err)),
      );
      return reconciled;
    },
    drain() {
      draining = true;
      // the cap waits go: a waiting row is deferred like a due one
      waits.retry();
      wake();
    },
    stop() {
      running = false;
      wake();
    },
    wake,
    pass,
    fire,
    runNow(row, user) {
      const result = attempt(row.id, "manual", user);
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
