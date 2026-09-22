// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A command's changes land together against the identities and revisions
// it mounted. Caps and receipt space are checked inside the transaction
// so a conflict or an unreportable change cannot leave a partial commit.

import type {
  KnowledgeAuthor,
  KnowledgeFile,
} from "../../shared/contracts/knowledge.ts";
import { type Db, transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { Conflict } from "../lib/errors.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import {
  checkFile,
  checkNames,
  checkScratchTotals,
  checkTotals,
} from "./check.ts";
import { output } from "./output.ts";
import type { Scratch, ScratchChanges, ScratchStore } from "./scratch.ts";
import type { KnowledgeStore } from "./store.ts";
import { lineCount } from "./text.ts";

export type Change = {
  name: string;
  before: KnowledgeFile | null;
  text: string | null;
};

export type CommandOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ScratchCommit = {
  sessionId: string;
  before: Scratch;
  changes: ScratchChanges;
  totals: { files: number; bytes: number };
};

export function commit(
  deps: {
    db: Db;
    store: KnowledgeStore;
    scratch: ScratchStore;
    current(): KnowledgeCaps;
  },
  projectId: string,
  author: KnowledgeAuthor,
  changes: readonly Change[],
  scratch: ScratchCommit,
  result: CommandOutput,
  extraReceipts: readonly string[],
  resultCut: number,
  signal: AbortSignal,
  now: number,
) {
  return transact(deps.db, () => {
    signal.throwIfAborted();
    const caps = deps.current();
    const { events, receipts } = commitKnowledge(
      deps.store,
      projectId,
      author,
      changes,
      caps,
      now,
    );
    checkScratchTotals(scratch.before, scratch.totals, caps);
    deps.scratch.write(
      scratch.sessionId,
      scratch.before.revision,
      scratch.changes,
      now,
    );
    const content = output(
      result.stdout,
      result.stderr,
      result.exitCode,
      [...receipts, ...extraReceipts],
      resultCut,
    );
    return { result: content, events };
  });
}

// The caller owns the transaction, including any scratch writes or receipts.
export function commitKnowledge(
  store: KnowledgeStore,
  projectId: string,
  author: KnowledgeAuthor,
  changes: readonly Change[],
  caps: KnowledgeCaps,
  now: number,
  source: "command" | "upload" = "command",
) {
  if (changes.length === 0) return { receipts: [], events: [] };
  const current = store.list(projectId);
  const live = new Map(current.map((file) => [file.name, file]));
  const names = new Set(live.keys());
  const before = store.totals(projectId);
  let bytes = before.bytes;
  const receipts: string[] = [];
  for (const change of changes) {
    const found = live.get(change.name);
    if (
      change.before === null
        ? found !== undefined
        : found?.id !== change.before.id ||
          found.revision !== change.before.revision
    ) {
      throw new Conflict(
        source === "upload"
          ? `${change.name} changed while uploading, try again`
          : `${change.name} changed while the command ran, read it again`,
      );
    }
    bytes -= found?.bytes ?? 0;
    if (change.text === null) {
      names.delete(change.name);
      receipts.push(`deleted ${change.name}`);
    } else {
      const nextBytes = Buffer.byteLength(change.text);
      checkFile(change.name, nextBytes, found?.bytes ?? 0, caps);
      bytes += nextBytes;
      names.add(change.name);
      receipts.push(
        `wrote ${change.name} (rev ${(found?.revision ?? 0) + 1}, ${lineCount(change.text)} lines)`,
      );
    }
  }
  checkNames([...names]);
  if (changes.some((change) => change.text !== null)) {
    checkTotals(before, { files: names.size, bytes }, caps);
  }
  const events: Extract<BusEvent, { type: "knowledge.changed" }>[] = [];
  for (const change of changes) {
    const deleted = change.text === null;
    const file =
      change.text === null
        ? store.remove(change.before!, author, now)
        : change.before === null
          ? store.create(projectId, author, change.name, change.text, now)
          : store.replace(change.before, author, change.text, now);
    events.push({
      type: "knowledge.changed",
      data: { projectId, file, deleted },
    });
  }
  store.evict(
    projectId,
    events.map((event) => event.data.file.id),
    caps,
  );
  return { receipts, events };
}
