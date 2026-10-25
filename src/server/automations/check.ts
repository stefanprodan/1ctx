// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A scheduled fire's check (docs/automations.md, The check): one GET in
// flight per automation, never awaited by the pass; its answer waits for
// the pass its wake starts.

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
  noteAnswer,
  recordCheck,
  saveValidators,
  type Validators,
  validators,
} from "./check-rows.ts";
import { nextFire } from "./schedule.ts";
import { type AutomationStore, automationChanged } from "./store.ts";

// an edit, a move of the due time or a suspend makes it stale
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

// the due time when the row is as the held answer saw it, else null
export type Due = (row: AutomationSummary, held: Held) => number | null;

export function checks(deps: CheckDeps) {
  const flying = new Map<
    string,
    { abort: AbortController; done: Promise<void> }
  >();
  const ready = new Map<string, Held>();
  // saved only when the run ends, so a cut run asks the same again
  const seen = new Map<
    string,
    Validators & { automationId: string; editRevision: number; cut: boolean }
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
        // the message may name the URL. A failed answer moves next_at,
        // so the row never asks again at once
        const { error: _, ...fields } = errorFields(err);
        deps.log.error("check error", { automation: row.id, ...fields });
        if (!abort.signal.aborted) keep({ result: "could not connect" });
      } finally {
        flying.delete(row.id);
        if (!abort.signal.aborted) deps.wake();
      }
    })();
    flying.set(row.id, { abort, done });
  };

  // only a check silent past CHECK_SILENCE_MS opens or joins the alert;
  // a dismissed one stays closed
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

  // a quiet or failed answer; false when it was stale
  const settle = (
    id: string,
    source: EventSource,
    held: Held,
    due: Due,
  ): boolean => {
    const result = held.answer.result;
    const failed = isCheckFailure(result);
    const applied = transact(deps.db, () => {
      const row = deps.store.byId(id);
      const dueAt = row === null ? null : due(row, held);
      if (row === null || dueAt === null) return { result: false };
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
        result: true,
        events: [automationChanged(updated), ...events],
      };
    });
    if (applied && failed) {
      deps.log.info("check failed", {
        automation: id,
        result,
        duration: deps.clock() - held.startedAt,
      });
    }
    return applied;
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
    // a new answer whose run did not start restarts the silence, though
    // nothing it said is kept
    answered(id: string, held: Held) {
      try {
        transact(deps.db, () => {
          if (!noteAnswer(deps.db, id, held.url, deps.clock())) {
            return { result: undefined };
          }
          const row = deps.store.byId(id);
          return {
            result: undefined,
            events: row === null ? [] : [automationChanged(row)],
          };
        });
      } catch (err) {
        deps.log.error("check record failed", {
          automation: id,
          ...errorFields(err),
        });
      }
    },
    prune(due: Set<string>) {
      for (const id of ready.keys()) if (!due.has(id)) ready.delete(id);
    },
    // in the fire's transaction, once its run started
    started(id: string) {
      checkAnswered(deps.db, id);
      recordCheck(deps.db, id, {
        at: deps.clock(),
        result: "200",
        answered: true,
      });
    },
    // after the fire's commit
    hold(sessionId: string, automationId: string, held: Held) {
      const answer = held.answer as NewAnswer;
      seen.set(sessionId, {
        automationId,
        editRevision: held.editRevision,
        cut: false,
        etag: answer.etag,
        lastModified: answer.lastModified,
        hash: answer.hash,
      });
    },
    // in the run's last transaction: a shutdown reached its work after
    // the answer, so its validators are not saved
    interrupted(sessionId: string): void {
      const kept = seen.get(sessionId);
      if (kept !== undefined) kept.cut = true;
    },
    // a run a shutdown or restart cut saves nothing, so the next check
    // repeats its answer
    ended(sessionId: string, cut: () => boolean): void {
      const kept = seen.get(sessionId);
      if (kept === undefined) return;
      seen.delete(sessionId);
      if (kept.cut || cut()) return;
      saveValidators(deps.db, kept.automationId, kept.editRevision, kept);
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
