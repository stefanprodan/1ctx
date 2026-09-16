// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The durable note and the pure replay used when its revision moved while a
// run held a working copy.

import type { MemoryEntry } from "../../shared/contracts/memory.ts";
import {
  applyEdit,
  checkEntries,
  entriesEqual,
  entryEqual,
  type MemoryEdit,
  normalize,
} from "../../shared/memory.ts";
import type { Db } from "../db/index.ts";
import { BadRequest, Conflict } from "../lib/errors.ts";

export type MemoryTarget = {
  projectId: string;
  automationId: string | null;
};

export type MemoryRow = MemoryTarget & {
  entries: MemoryEntry[];
  previous: MemoryEntry[] | null;
  revision: number;
  updatedAt: number | null;
  updatedBy: string | null;
  sessionId: string | null;
};

export type MemoryOperation =
  | { action: "none" }
  | (Exclude<MemoryEdit, { action: "none" }> & { expected: string | null });

export type MemoryWork = {
  target: MemoryTarget;
  baseRevision: number;
  entries: MemoryEntry[];
  operations: MemoryOperation[];
  failedRounds: number;
};

export type MemoryCommit = {
  row: MemoryRow;
  skipped: number;
  skippedOperations: number[];
  changed: boolean;
};

type Raw = {
  project_id: string;
  automation_id: string | null;
  entries: string;
  previous_entries: string | null;
  revision: number;
  updated_at: number;
  updated_by: string | null;
  session_id: string | null;
};

function entries(value: string): MemoryEntry[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("invalid stored memory entries");
  return parsed.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("topic" in entry) ||
      typeof entry.topic !== "string" ||
      !("text" in entry) ||
      typeof entry.text !== "string"
    )
      throw new Error("invalid stored memory entry");
    return { topic: entry.topic, text: entry.text };
  });
}

function row(raw: Raw): MemoryRow {
  return {
    projectId: raw.project_id,
    automationId: raw.automation_id,
    entries: entries(raw.entries),
    previous:
      raw.previous_entries === null ? null : entries(raw.previous_entries),
    revision: raw.revision,
    updatedAt: raw.updated_at,
    updatedBy: raw.updated_by,
    sessionId: raw.session_id,
  };
}

export function replay(
  current: readonly MemoryEntry[],
  operations: readonly MemoryOperation[],
): { entries: MemoryEntry[]; skipped: number; skippedOperations: number[] } {
  let entries = [...current];
  const skippedOperations: number[] = [];
  for (const [index, operation] of operations.entries()) {
    if (operation.action === "none") continue;
    const current = entries.find(
      (entry) => entry.topic.toLowerCase() === operation.topic.toLowerCase(),
    );
    const resultThere =
      operation.action === "remove"
        ? current === undefined
        : current !== undefined && entryEqual(current, operation);
    if (resultThere) continue;
    const expected = operation.expected;
    const matches =
      expected === null
        ? current === undefined
        : current !== undefined &&
          entryEqual(current, { topic: operation.topic, text: expected });
    if (!matches) {
      skippedOperations.push(index);
      continue;
    }
    const result = applyEdit(entries, operation);
    if (result.ok) entries = result.entries;
    else skippedOperations.push(index);
  }
  return { entries, skipped: skippedOperations.length, skippedOperations };
}

export function memoryWork(row: MemoryRow): MemoryWork {
  return {
    target: { projectId: row.projectId, automationId: row.automationId },
    baseRevision: row.revision,
    entries: [...row.entries],
    operations: [],
    failedRounds: 0,
  };
}

export class MemoryStore {
  constructor(private readonly db: Db) {}

  read(target: MemoryTarget): MemoryRow {
    const raw = this.db
      .query<Raw, [string, string | null]>(
        `select * from memory_notes
         where project_id = ? and automation_id is ?`,
      )
      .get(target.projectId, target.automationId);
    return raw
      ? row(raw)
      : {
          ...target,
          entries: [],
          previous: null,
          revision: 0,
          updatedAt: null,
          updatedBy: null,
          sessionId: null,
        };
  }

  save(
    target: MemoryTarget,
    next: readonly MemoryEntry[],
    revision: number,
    userId: string,
    now: number,
  ): MemoryRow {
    const current = this.read(target);
    if (current.revision !== revision) throw new Conflict("memory changed");
    this.assertTarget(target);
    const normalized = normalize(next);
    const problem = checkEntries(normalized);
    if (problem !== null) throw new BadRequest(`entries: ${problem}`);
    this.write(target, current, normalized, userId, null, now);
    return this.read(target);
  }

  undo(
    target: MemoryTarget,
    revision: number,
    userId: string,
    now: number,
  ): MemoryRow {
    const current = this.read(target);
    if (current.revision !== revision) throw new Conflict("memory changed");
    if (current.previous === null) throw new Conflict("nothing to undo");
    this.assertTarget(target);
    this.write(target, current, current.previous, userId, null, now);
    return this.read(target);
  }

  commit(work: MemoryWork, sessionId: string, now: number): MemoryCommit {
    const current = this.read(work.target);
    const applied =
      current.revision === work.baseRevision
        ? { entries: [...work.entries], skipped: 0, skippedOperations: [] }
        : replay(current.entries, work.operations);
    if (
      work.operations.length === 0 ||
      entriesEqual(current.entries, applied.entries)
    ) {
      return {
        row: current,
        skipped: applied.skipped,
        skippedOperations: applied.skippedOperations,
        changed: false,
      };
    }
    this.assertTarget(work.target);
    this.write(work.target, current, applied.entries, null, sessionId, now);
    return {
      row: this.read(work.target),
      skipped: applied.skipped,
      skippedOperations: applied.skippedOperations,
      changed: true,
    };
  }

  private assertTarget(target: MemoryTarget): void {
    if (target.automationId === null) return;
    const found = this.db
      .query<{ project_id: string }, [string]>(
        "select project_id from automations where id = ?",
      )
      .get(target.automationId);
    if (found?.project_id !== target.projectId) {
      throw new Conflict("automation is not in project");
    }
  }

  private write(
    target: MemoryTarget,
    current: MemoryRow,
    next: readonly MemoryEntry[],
    userId: string | null,
    sessionId: string | null,
    now: number,
  ): void {
    if (current.revision === 0) {
      this.db
        .query(
          `insert into memory_notes
            (project_id, automation_id, entries, previous_entries, revision,
             updated_at, updated_by, session_id)
           values (?, ?, ?, '[]', 1, ?, ?, ?)`,
        )
        .run(
          target.projectId,
          target.automationId,
          JSON.stringify(next),
          now,
          userId,
          sessionId,
        );
      return;
    }
    const changed = this.db
      .query(
        `update memory_notes set entries = ?, previous_entries = ?,
           revision = revision + 1, updated_at = ?, updated_by = ?,
           session_id = ?
         where project_id = ? and automation_id is ? and revision = ?`,
      )
      .run(
        JSON.stringify(next),
        JSON.stringify(current.entries),
        now,
        userId,
        sessionId,
        target.projectId,
        target.automationId,
        current.revision,
      ).changes;
    if (changed === 0) throw new Conflict("memory changed");
  }
}
