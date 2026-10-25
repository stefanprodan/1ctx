// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A scheduled fire's check (docs/automations.md, The check): one GET in
// flight per automation, never awaited by the pass, its answer held for
// the pass its wake starts, and a new answer's validators kept by its
// run until that run ends.

import {
  type AutomationSummary,
  CHECK_SILENCE_MS,
  type CheckFailure,
  checkReason,
  isCheckFailure,
} from "../../shared/contracts/automation.ts";
import type { EventSource } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import { type Db, transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { AlertEmails } from "./alert-email.ts";
import {
  type CheckAnswer,
  type CheckPorts,
  check,
  MAX_CHECK_BYTES,
  type NewAnswer,
} from "./check-fetch.ts";
import {
  checkAnswered,
  checkFailed,
  recordCheck,
  saveValidators,
  type Validators,
  validators,
} from "./check-rows.ts";
import { nextFire } from "./schedule.ts";
import { type AutomationStore, automationChanged } from "./store.ts";

// an answer and the row it was asked for: an edit, a move of the due
// time or a suspend since makes it stale
export type Held = {
  answer: CheckAnswer;
  url: string;
  editRevision: number;
  dueAt: number;
  startedAt: number;
};

export type CheckDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  store: AutomationStore;
  ports: CheckPorts;
  agents: { byId(id: string): AgentRow | null };
  limits(): { mcpKeptBytes: number };
  emails?: AlertEmails;
  wake(): void;
};

// the row as the held answer saw it, and its due time now; null when
// stale
export type Due = (row: AutomationSummary, held: Held) => number | null;

export function checks(deps: CheckDeps) {
  const flying = new Map<
    string,
    { abort: AbortController; done: Promise<void> }
  >();
  const ready = new Map<string, Held>();
  // a new answer's validators, saved when its run ends
  const seen = new Map<
    string,
    Validators & { automationId: string; url: string }
  >();

  const ask = (row: AutomationSummary, dueAt: number): void => {
    if (flying.has(row.id) || row.checkUrl === null) return;
    const url = row.checkUrl;
    const abort = new AbortController();
    const startedAt = deps.clock();
    const agent = deps.agents.byId(row.agentId);
    const keep = (answer: CheckAnswer) =>
      ready.set(row.id, {
        answer,
        url,
        editRevision: row.editRevision,
        dueAt,
        startedAt,
      });
    const done = (async () => {
      try {
        const answer = await check(
          deps.ports,
          deps.clock,
          {
            url,
            projectId: row.projectId,
            servers: agent?.servers ?? [],
            disabled: row.disabledCapabilities,
            ...validators(deps.db, row.id),
            maxBytes: Math.min(MAX_CHECK_BYTES, deps.limits().mcpKeptBytes),
          },
          abort.signal,
        );
        if (answer !== null && !abort.signal.aborted) keep(answer);
      } catch (err) {
        // the message may name the URL; a failed answer moves next_at, so
        // the row never asks again at once
        const { error: _, ...fields } = errorFields(err);
        deps.log.error("check failed", { automation: row.id, ...fields });
        if (!abort.signal.aborted) keep({ result: "could not connect" });
      } finally {
        flying.delete(row.id);
        if (!abort.signal.aborted) deps.wake();
      }
    })();
    flying.set(row.id, { abort, done });
  };

  // the alert's side of a failure: silent past CHECK_SILENCE_MS opens
  // it, or joins one open; a dismissed one stays closed
  const silent = (row: AutomationSummary, now: number): BusEvent[] => {
    if (
      row.lastAnsweredAt !== null &&
      now - row.lastAnsweredAt <= CHECK_SILENCE_MS
    ) {
      return [];
    }
    const change = checkFailed(deps.db, row.id, now);
    if (change !== "opened") return [];
    const opened = deps.store.byId(row.id)!;
    return [
      ...(deps.emails?.opened(opened, null) ?? []),
      {
        type: "automation.attention",
        data: {
          projectId: opened.projectId,
          automationId: opened.id,
          sessionId: null,
          since: now,
        },
      },
    ];
  };

  // a quiet or failed answer: the row's check recorded, next_at moved
  // when the fire was the schedule's, and a failure's skipped event
  const settle = (
    id: string,
    source: EventSource,
    held: Held,
    due: Due,
  ): void => {
    const result = held.answer.result;
    const failed = isCheckFailure(result);
    transact(deps.db, () => {
      const row = deps.store.byId(id);
      const dueAt = row === null ? null : due(row, held);
      if (row === null || dueAt === null) return { result: undefined };
      const now = deps.clock();
      const nextAt =
        row.nextAt !== null && row.nextAt <= now
          ? nextFire(row.schedule, row.tz, now)
          : undefined;
      if (failed) {
        deps.store.recordEvent(row.id, {
          at: now,
          dueAt,
          source,
          outcome: "skipped",
          reason: checkReason(result as CheckFailure),
        });
      } else {
        checkAnswered(deps.db, row.id);
      }
      recordCheck(deps.db, row.id, {
        at: now,
        result,
        answered: !failed,
        ...(nextAt === undefined ? {} : { nextAt }),
      });
      const events = failed ? silent(row, now) : [];
      const updated = deps.store.byId(row.id)!;
      return {
        result: undefined,
        events: [automationChanged(updated), ...events],
      };
    });
    if (failed) {
      deps.log.info("check failed", {
        automation: id,
        result,
        duration: deps.clock() - held.startedAt,
      });
    }
  };

  return {
    ask,
    settle,
    busy: (id: string) => flying.has(id),
    get flying() {
      return flying.size > 0;
    },
    take(id: string): Held | undefined {
      const held = ready.get(id);
      ready.delete(id);
      return held;
    },
    drop(id: string) {
      ready.delete(id);
    },
    // the answers of rows no longer due or listed go
    prune(due: Set<string>) {
      for (const id of ready.keys()) if (!due.has(id)) ready.delete(id);
    },
    // in the fire's transaction, once its run started: the check
    // recorded and the check's alert closed
    started(id: string) {
      checkAnswered(deps.db, id);
      recordCheck(deps.db, id, {
        at: deps.clock(),
        result: "200",
        answered: true,
      });
    },
    // after the fire's commit: the run holds its answer's validators
    hold(sessionId: string, automationId: string, held: Held) {
      const answer = held.answer as NewAnswer;
      seen.set(sessionId, {
        automationId,
        url: held.url,
        etag: answer.etag,
        lastModified: answer.lastModified,
        hash: answer.hash,
      });
    },
    // a run's end saves what its answer said, but for a run a shutdown
    // or a restart cut, whose answer the next check repeats
    ended(sessionId: string, cut: () => boolean): void {
      const kept = seen.get(sessionId);
      if (kept === undefined) return;
      seen.delete(sessionId);
      if (cut()) return;
      saveValidators(deps.db, kept.automationId, kept.url, kept);
    },
    abort() {
      for (const { abort } of flying.values()) abort.abort();
      ready.clear();
    },
    async settled(): Promise<void> {
      while (flying.size > 0) {
        await Promise.all([...flying.values()].map((entry) => entry.done));
      }
    },
  };
}

export type Checks = ReturnType<typeof checks>;
