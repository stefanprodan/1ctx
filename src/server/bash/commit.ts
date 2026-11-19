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
import type { Change } from "../knowledge/index.ts";
import { checkUsage } from "../knowledge/rules.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import { checkScratchNames } from "./names.ts";
import { output } from "./output.ts";
import { mountPath } from "./paths.ts";
import type { Changes } from "./protocol.ts";
import type { Scratch, ScratchChanges, ScratchStore } from "./scratch.ts";
import type { Workspace } from "./workspace.ts";

// the docs commit, bound to knowledge's store; it opens no transaction
// and runs inside the command's
export type CommitDocs = (
  projectId: string,
  author: KnowledgeAuthor,
  changes: readonly Change[],
  caps: KnowledgeCaps,
  now: number,
) => { receipts: string[]; events: BusEvent[] };

// a doc as the commit stored it; a delete has no text
export type Committed = {
  name: string;
  id: string;
  revision: number;
  updatedAt: number;
  text: string | null;
};

// what a landed commit wrote, for the shell that ran the command
export type Landed = {
  docs: Committed[];
  scratch: { revision: number; usedAt: number };
};

export type CommandOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ScratchCommit = {
  workspace: Workspace;
  before: Scratch;
  changes: ScratchChanges;
  // the shell keeps /tmp itself: no file changes, so no cap or name is
  // held to rows the command never saw
  owned?: boolean;
};

export function checkScratchTotals(
  before: { files: number; bytes: number },
  after: { files: number; bytes: number },
  caps: KnowledgeCaps,
): void {
  checkUsage(before, after, caps.scratchFiles, caps.scratchBytes, "scratch");
}

// What the worker answered, held to the mounted trees: no doc changes
// with the docs off, a delete names a mounted doc, no name twice, and
// scratch removes only what it mounted and writes no more files than
// it may hold, since a command inside could post an answer of its own.
export function checked(
  changes: Changes | null,
  docs: ReadonlyMap<string, KnowledgeFile>,
  scratch: Scratch,
  knowledge: boolean,
  scratchFiles: number,
): Changes {
  if (changes === null || (!knowledge && changes.knowledge.length > 0))
    throw new Error("the command worker answered out of protocol");
  // bounded before a row is written or a name walked; a lowered cap
  // still lets an oversized scratch rewrite what it holds
  if (changes.written.length > Math.max(scratchFiles, scratch.files))
    throw new Error(
      `the scratch would have ${changes.written.length} files, the limit is ${scratchFiles}`,
    );
  const names = new Set(changes.knowledge.map((change) => change.name));
  const written = new Set(changes.written.map((file) => file.path));
  const mounted = new Set(scratch.entries.map((file) => file.path));
  if (
    names.size !== changes.knowledge.length ||
    changes.knowledge.some(
      (change) => change.text === null && !docs.has(change.name),
    ) ||
    written.size !== changes.written.length ||
    new Set(changes.removed).size !== changes.removed.length ||
    changes.removed.some((path) => !mounted.has(path) || written.has(path)) ||
    !mountPath(changes.cwd)
  )
    throw new Error("the command worker answered out of protocol");
  return changes;
}

// each changed doc's row as the commit left it, from its events, with
// the text it stored
function committedDocs(
  changes: readonly Change[],
  events: readonly BusEvent[],
): Committed[] {
  const texts = new Map(changes.map((change) => [change.name, change.text]));
  const out: Committed[] = [];
  for (const event of events) {
    if (event.type !== "knowledge.changed") continue;
    const file = event.data.file;
    out.push({
      name: file.name,
      id: file.id,
      revision: file.revision,
      updatedAt: file.updatedAt,
      text: event.data.deleted ? null : (texts.get(file.name) ?? null),
    });
  }
  return out;
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
    const revision = scratch.owned
      ? deps.scratch.writeCwd(
          scratch.workspace,
          scratch.before.revision,
          scratch.changes.cwd,
          now,
        )
      : deps.scratch.write(
          scratch.workspace,
          scratch.before.revision,
          scratch.changes,
          now,
        );
    // counted from the rows just written, so the caps hold whatever the
    // command worker answered, and bound the rows before their names are
    // walked
    if (!scratch.owned) {
      const stored = deps.scratch.sizes(scratch.workspace);
      checkScratchTotals(
        scratch.before,
        {
          files: stored.length,
          bytes: stored.reduce((sum, file) => sum + file.bytes, 0),
        },
        caps,
      );
      checkScratchNames(stored.map((file) => file.path));
    }
    const content = output(
      result.stdout,
      result.stderr,
      result.exitCode,
      [...receipts, ...extraReceipts],
      resultCut,
    );
    const saved = savedPaths(changes);
    const landed: Landed = {
      docs: committedDocs(changes, events),
      scratch: { revision, usedAt: now },
    };
    return {
      result: {
        printed: saved.length ? { ...content, saved } : content,
        landed,
      },
      events,
    };
  });
}
