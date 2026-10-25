// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
import { DEFERRED_BY_RESTART, type EventSource } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import { type Db, transact } from "../db/index.ts";
import { type BusEvent, subscribe } from "../lib/bus.ts";
import { type Clock, HOUR_MS, MINUTE_MS, sleep } from "../lib/clock.ts";
import { Conflict, HttpError, messageOf } from "../lib/errors.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { ProjectRow } from "../projects/index.ts";
import { type Event, type PreparedRun, RunCapacity } from "../runner/index.ts";
import type { SessionStore } from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import type { Checks, Held } from "./check.ts";
import { recordOn } from "./events.ts";
import { eventFor, manualFor, ownerFor } from "./fire-event.ts";
import { type Cut, cutRuns, deferDue, stillCut, withCut } from "./refire.ts";
import { nextFire } from "./schedule.ts";
import { type AutomationStore, automationChanged } from "./store.ts";
import { onRunEnd, reconcileRuns, sweepRuns } from "./upkeep.ts";
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
  checks: Checks;
  // the limit a new answer's start in the first message is cut to
  resultCut(): number;
};

export type Scheduler = {
  start(): number;
  // from the first signal: nothing fires, what comes due is deferred
  drain(): void;
  stop(): void;
  wake(): void;
  pass(): Promise<void>;
  fire(id: string): Promise<SessionDetail | null>;
  // every check in flight answered or aborted
  checked(): Promise<void>;
  runNow(row: AutomationSummary, user: UserRow): SessionDetail;
  prepareNow(row: AutomationSummary, user: UserRow): PreparedRun;
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

  // when the row's fire is due by its source, null when it is not
  const dueOf = (row: AutomationSummary, source: EventSource) => {
    if (source === "restart") {
      const listed = cut.get(row.id);
      return stillCut(row, listed) ? listed!.listedAt : null;
    }
    return row.suspendedAt === null &&
      row.nextAt !== null &&
      row.nextAt <= deps.clock()
      ? row.nextAt
      : null;
  };

  // the held answer still meets its row: not edited, the same fire due
  const fresh = (row: AutomationSummary, source: EventSource, held: Held) =>
    row.editRevision === held.editRevision &&
    row.checkUrl === held.url &&
    dueOf(row, source) === held.dueAt
      ? held.dueAt
      : null;

  // one try at a fire; actor is the user of a manual one, else null
  const attempt = (
    id: string,
    source: EventSource,
    actor: UserRow | null,
    held?: Held,
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
        // a checked fire starts only with its answer; one that cannot run
        // at once is dropped, and the row left due checks again
        if (source !== "manual" && row.checkUrl !== null) {
          const running = deps.sessions.runningAutomation(row.id);
          if (held === undefined ? !running : running) return { result: null };
          if (held !== undefined && fresh(row, source, held) === null) {
            return { result: null };
          }
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
            actor === null ? ownerFor(deps, row) : manualFor(deps, row, actor);
          if (deps.sessions.runningAutomation(row.id)) {
            throw new Conflict("still running");
          }
          holder.value = deps.runner.startRun(
            eventFor(deps, row, source, dueAt!, resolved, held),
          );
          const prepared = holder.value;
          if (held !== undefined) deps.checks.started(row.id);
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
          // a run that took a due fire spends a once automation, after its
          // event: the table holds next_at null exactly while suspended.
          // A suspended row's restart run, which stillCut allows only
          // for its once run, carries that run on as the once run
          const session = prepared.detail.session.id;
          const updated =
            row.once && nextAt !== undefined
              ? deps.store.spendOnce(row.id, session, now)!
              : source === "restart" && row.suspendedAt !== null
                ? deps.store.carryOnceRun(row.id, session, now)!
                : recordedRun;
          recorded.value = { msg: "fire", user: resolved.user.username };
          return {
            result: {
              detail: prepared.detail,
              launch() {
                deps.log.info("fire", {
                  automation: id,
                  source,
                  user: resolved.user.username,
                });
                prepared.launch();
              },
              abandon: prepared.abandon,
            },
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
      if (recorded.value?.msg === "skip") {
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

  const fire = async (
    id: string,
    given?: AutomationSummary,
  ): Promise<SessionDetail | null> => {
    if (draining) {
      deferDue(deps, id, deps.clock());
      return null;
    }
    const seen = waits.generation;
    const source = cut.has(id) ? "restart" : "schedule";
    const row = given ?? deps.store.byId(id);
    let held: Held | undefined;
    // a checked fire asks first, unless a run going skips it at once
    if (row?.checkUrl && !deps.sessions.runningAutomation(id)) {
      if (deps.checks.busy(id)) return null;
      held = deps.checks.take(id);
      const dueAt = dueOf(row, source);
      if (held === undefined && dueAt !== null) {
        deps.checks.ask(row, dueAt);
        return null;
      }
      if (held !== undefined && held.answer.result !== "200") {
        cut.delete(id);
        try {
          deps.checks.settle(id, source, held, (current) =>
            fresh(current, source, held!),
          );
        } catch (err) {
          deps.log.error("check record failed", {
            automation: id,
            ...errorFields(err),
          });
        }
        return null;
      }
    }
    try {
      const result = attempt(id, source, null, held);
      if (result !== null && "wait" in result) {
        waits.block(id, result, seen, deps.clock());
        return null;
      }
      // a dropped answer leaves a restart rerun listed, to ask again
      if (result !== null || held === undefined) cut.delete(id);
      if (result === null) return null;
      waits.started(id);
      if (held !== undefined) {
        deps.checks.hold(result.detail.session.id, id, held);
      }
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

  const sweep = () => sweepRuns(deps);
  const reconcile = () => reconcileRuns(deps);
  const onSession = (event: BusEvent) => onRunEnd(deps, event);

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
    const listed = new Set([...due.map((row) => row.id), ...cut.keys()]);
    waits.prune(listed);
    deps.checks.prune(listed);
    for (const row of due) {
      if (!keepGoing()) return;
      replaceMissed(deps, row.id, now);
    }
    // oldest first, due and waiting alike, then the cut runs; a full
    // project passes over its rows, a full process ends the fires
    for (const row of withCut(deps.store.due(now), cut, deps.store)) {
      if (!keepGoing()) break;
      // an answer that cannot run at once is dropped, never held
      if (waits.processFull || waits.projectFull(row.projectId)) {
        deps.checks.drop(row.id);
        continue;
      }
      await fire(row.id, row);
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
    // while a cap is full or a check is out the rows left due are
    // waits, not wakes: the answer wakes the loop
    const earliest = deps.store.earliest(
      waits.any || draining || deps.checks.flying ? passAt : null,
    );
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

  const prepareNow = (row: AutomationSummary, user: UserRow): PreparedRun => {
    const result = attempt(row.id, "manual", user);
    if (result === null || "wait" in result) {
      throw new Conflict("no such automation");
    }
    return result;
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
      deps.checks.abort();
      wake();
    },
    stop() {
      running = false;
      deps.checks.abort();
      wake();
    },
    wake,
    pass,
    fire: (id) => fire(id),
    checked: () => deps.checks.settled(),
    runNow(row, user) {
      const result = prepareNow(row, user);
      result.launch();
      return result.detail;
    },
    prepareNow,
    sweep,
    reconcile,
    dispose() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

type Started = PreparedRun | Waiting;
