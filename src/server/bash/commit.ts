// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A command's changes land together against the identities and revisions
// it mounted. Caps and receipt space are checked inside the transaction
// so a conflict or an unreportable change cannot leave a partial commit.

import type { KnowledgeAuthor } from "../../shared/contracts/knowledge.ts";
import { type Db, transact } from "../db/index.ts";
import type { Change } from "../knowledge/index.ts";
import { checkUsage } from "../knowledge/rules.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import { checkScratchNames } from "./names.ts";
import { output } from "./output.ts";
import type { Scratch, ScratchChanges, ScratchStore } from "./scratch.ts";

// the docs commit, bound to knowledge's store; it opens no transaction
// and runs inside the command's
export type CommitDocs = (
  projectId: string,
  author: KnowledgeAuthor,
  changes: readonly Change[],
  caps: KnowledgeCaps,
  now: number,
) => { receipts: string[]; events: BusEvent[] };

export type CommandOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ScratchCommit = {
  sessionId: string;
  before: Scratch;
  changes: ScratchChanges;
};

export function checkScratchTotals(
  before: { files: number; bytes: number },
  after: { files: number; bytes: number },
  caps: KnowledgeCaps,
): void {
  checkUsage(before, after, caps.scratchFiles, caps.scratchBytes, "scratch");
}

// the docs a command wrote, as paths a reader can cat, in commit order;
// a delete saved nothing and is left out
export const savedPaths = (changes: readonly Change[]): string[] =>
  changes
    .filter((change) => change.text !== null)
    .map((change) => `/knowledge/${change.name}`);

export function commit(
  deps: {
    db: Db;
    scratch: ScratchStore;
    commitDocs: CommitDocs;
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
    const { events, receipts } = deps.commitDocs(
      projectId,
      author,
      changes,
      caps,
      now,
    );
    deps.scratch.write(
      scratch.sessionId,
      scratch.before.revision,
      scratch.changes,
      now,
    );
    // counted from the rows just written, so the caps hold whatever the
    // command worker answered, and bound the rows before their names are
    // walked
    const stored = deps.scratch.sizes(scratch.sessionId);
    checkScratchTotals(
      scratch.before,
      {
        files: stored.length,
        bytes: stored.reduce((sum, file) => sum + file.bytes, 0),
      },
      caps,
    );
    checkScratchNames(stored.map((file) => file.path));
    const content = output(
      result.stdout,
      result.stderr,
      result.exitCode,
      [...receipts, ...extraReceipts],
      resultCut,
    );
    const saved = savedPaths(changes);
    return { result: saved.length ? { ...content, saved } : content, events };
  });
}
