// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A command's save, in the sandbox's turn: the fence when it ran
// alone, a complete walk read against the base, the changed files and
// the records pulled, its own records removed, and the read back by the
// shared rules against the doc rows (shared.ts); after a landed commit,
// the put-back.

import type {
  Answer,
  Job,
  Settled,
  SettleOutcome,
  ShellContext,
} from "../bash/index.ts";

type Landed = Extract<SettleOutcome, { landed: true }>;

import { discardNotices, readBack } from "../bash/index.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import {
  committedTree,
  docsWanted,
  emptyManifest,
  manifestOf,
  type Tree,
  type Wanted,
} from "./baseline.ts";
import { walkBounds } from "./bounds.ts";
import { type Execs, fence, pull, push, removeRecords, walk } from "./execs.ts";
import { SANDBOX_ROOTS } from "./frames.ts";
import type { SandboxHold } from "./hold.ts";
import {
  fill,
  openedOf,
  RECORD_ROOTS,
  type Readout,
  readout,
  recordBounds,
  recordedCwd,
  recordRequests,
} from "./readout.ts";
import { scrubPulled } from "./scrub.ts";
import {
  againstRows,
  alone as aloneIn,
  conflictWords,
  keptForLater,
  leftInPlace,
  noteImports,
  oldestPush,
  onlyBase,
  onlyPaths,
  outsideKnowledge,
  type Shared,
  savedJob,
  spared,
} from "./shared.ts";

export type Rows = ReturnType<NonNullable<ShellContext["docs"]>>;

export type Printed = Omit<Answer, "changes" | "refused">;

export type SaveFrom = {
  on: Execs;
  hold: SandboxHold;
  job: Job;
  context: ShellContext;
  shared: Shared;
  // what the command's push wanted, whose bytes stand for the base's
  wanted: Wanted;
  // the docs the push read, which hold while no other command moved
  // the base since
  docs: Docs | null;
  // the base's version the command's rows are as new as
  seen: number;
  // the base's version its push made; the save judges imports by the
  // oldest running command's
  pushed: number;
  caps: KnowledgeCaps;
  phase?: (phase: "run" | "diff") => void;
  // a folder the sandbox holds alone, asked by an exec
  own(path: string): Promise<boolean> | null;
  // the fence ran, so nothing an earlier command started runs on
  fenced(): void;
  late(): boolean;
};

export type Saved = {
  settled: Settled;
  read: Readout | null;
  // the docs the save read against, for the put-back
  fresh: Wanted;
  // the rows read again, when they were
  rows?: Rows;
  // recycle at settle, whatever lands
  dirty: boolean;
  // what the save left in place, which the put-back leaves too
  left: Set<string>;
  // beside other commands, the paths a conflict puts back; null for
  // every change it read, which only a landed save puts back
  only: Set<string> | null;
  // a docs-off save beside a command with docs, which never read
  // /knowledge: that command's to judge
  blind: boolean;
};

export type Docs = { wanted: Wanted; files: Job["knowledge"]; rows?: Rows };

// the docs read before, the job's at first, while no other command
// moved the base since they were read, else the rows as they stand now
export function docsNow(
  from: Pick<SaveFrom, "shared" | "seen" | "context" | "job">,
  before: Docs | null = null,
): Docs {
  const { shared, context, job } = from;
  const fresh = shared.version !== from.seen;
  if (!fresh && before !== null) return before;
  const rows = fresh ? context.docs?.() : undefined;
  if (rows === undefined) {
    const docs = job.knowledge.map((file, index) => ({
      ...context.mounted.docs[index]!,
      data: file.data,
    }));
    return { wanted: docsWanted(docs, shared.base), files: job.knowledge };
  }
  return {
    wanted: docsWanted(rows, shared.base),
    files: rows.map((row) => ({
      name: row.name,
      data: row.data,
      mtime: row.updatedAt,
    })),
    rows,
  };
}

export async function readSaved(
  from: SaveFrom,
  id: string,
  start: string,
  printed: Printed,
): Promise<Saved> {
  const { on, hold, context } = from;
  const base = from.shared.base!;
  const now = from.job.docs ? docsNow(from, from.docs) : null;
  const fresh = now?.wanted ?? { tree: new Map(), bytes: new Map() };
  let left = new Set<string>();
  let only: Set<string> | null = null;
  // a command with docs beside it may be midway through a change there
  const blind = !from.job.docs && from.shared.docs > 0;
  const saved = (settled: Settled, read: Readout | null, dirty = true) => ({
    settled,
    read,
    fresh,
    ...(now?.rows === undefined ? {} : { rows: now.rows }),
    dirty,
    left,
    only,
    blind,
  });
  const job = savedJob(from.job, now?.files ?? [], base);
  // the sandbox as the base holds it, with this job's bytes where its
  // rows are the base's
  const wanted: Wanted = {
    tree: blind ? outsideKnowledge(base) : base,
    bytes: from.wanted.bytes,
  };
  // with no other command running, nothing it started outlives it
  const alone = aloneIn(from.shared);
  if (alone) {
    await fence(on, hold.keepAlivePid, hold.keepAliveStart);
    from.fenced();
  }
  const { limits, bounds } = walkBounds(from.caps, base);
  const roots = blind
    ? SANDBOX_ROOTS.filter((root) => root !== "/knowledge")
    : SANDBOX_ROOTS;
  const walked = await walk(on, limits, bounds, roots, !alone);
  const read = readout(
    walked.entries,
    job,
    wanted,
    context.credentials,
    walked.moved,
  );
  const notice = discardNotices(read.entries, job) + printed.notice;
  from.phase?.("diff");
  const shown = { ...printed, notice };
  const open = !from.job.subagent;
  const records = recordRequests(id, open);
  // a record is read with its own bound, never a tree's file bound
  const openBytes = Math.max(
    job.knowledgeFileBytes,
    job.repos.length > 0 ? job.repoFileBytes : 0,
  );
  const paths = recordBounds(id, open, openBytes);
  const named = [...paths.values()].reduce((sum, at) => sum + at, 0);
  const frames = await pull(
    on,
    [...read.pulls.keys(), ...records],
    {
      fileBytes: Math.max(limits.fileBytes, openBytes),
      totalBytes: limits.totalBytes + named,
      paths,
    },
    [...roots, ...RECORD_ROOTS],
  );
  fill(read, frames, !alone);
  // a key the command was handed is never saved or shown
  const scrubbed = scrubPulled(read, frames, context.credentials);
  const pwd = recordedCwd(id, scrubbed) ?? start;
  const opened = open
    ? openedOf(id, scrubbed, job.visuals, context.credentials)
    : [];
  // its own records go; alone, every record does, since what a command
  // left there would fill it
  await removeRecords(on, alone ? null : id);
  // beside other commands, what may be one's work in progress stays
  if (now !== null && !alone) left = leftInPlace(read, base, now.wanted, job);
  const against =
    now === null
      ? { entries: read.entries, conflicts: [] }
      : againstRows(read, base, now.wanted, left, {
          imported: from.shared.imported,
          pushed: oldestPush(from.shared, from.pushed),
        });
  // no scratch file is mounted or read back: /tmp is the sandbox's
  let back =
    against.conflicts.length > 0
      ? { changes: null, refused: conflictWords(against.conflicts, alone) }
      : await readBack(
          against.entries,
          { ...job, scratch: [] },
          {
            exitCode: printed.exitCode,
            // a real shell's 124 or 126 is the command's own
            stopped: false,
            start,
            pwd,
            isDirectory: (path) => from.own(path) ?? read.folders.has(path),
          },
        );
  // beside other commands a conflict puts back only the moved docs, and
  // any other refusal nothing
  if (!alone && against.conflicts.length > 0) only = new Set(against.conflicts);
  else if (!alone && back.refused !== null && now !== null)
    back = { ...back, refused: keptForLater(back.refused) };
  // the read back is the server's own work and may pass the deadline
  // after the last exec: what ends late saves nothing, as a late exec
  if (from.late())
    return saved(
      {
        ok: true,
        answer: {
          ...printed,
          exitCode: 124,
          changes: null,
          refused: null,
          stopped: "deadline",
        },
      },
      read,
    );
  // a change that cannot commit leaves a tree the rows do not hold
  return saved(
    { ok: true, answer: { ...shown, opened, ...back } },
    read,
    back.changes === null || read.discarded,
  );
}

// A commit that found a doc another chat moved after the save read the
// rows: beside other commands that doc is put back as the rows hold it
// now, as a conflict the save named, so a read again sees their edit
export function movedAtCommit(
  outcome: SettleOutcome,
  context: ShellContext,
  base: Tree,
): { only: Set<string>; fresh: Wanted; words: string } | null {
  if (outcome.landed || outcome.why !== "thrown") return null;
  const rows = outcome.moved === undefined ? undefined : context.docs?.();
  if (rows === undefined) return null;
  const path = `/knowledge/${outcome.moved}`;
  return {
    only: new Set([path]),
    fresh: docsWanted(rows, base),
    words: conflictWords([path], false),
  };
}

// the words a command stopped by another's recycle ends with
export const RECYCLED =
  "the sandbox was recycled while the command ran, so it saved nothing";

// After a landed commit, or a conflict beside others, still in the
// turn: the walked /knowledge put back to what the rows store, which
// becomes the base. Beside other commands what the save left in place
// stays, and every folder (spared()); a conflict puts back only the
// moved docs (onlyPaths()), the rest saved later
export async function putBack(
  on: Execs,
  shared: Shared,
  read: Readout,
  before: Wanted,
  docs: Landed["docs"],
  beside: {
    alone: boolean;
    left: ReadonlySet<string>;
    only: ReadonlySet<string> | null;
  },
): Promise<void> {
  const after = committedTree(before, docs);
  const { only } = beside;
  const all = manifestOf(read.held, after, ["/knowledge"]);
  const manifest = spared(
    only === null ? all : onlyPaths(all, only),
    read.held,
    beside.left,
    beside.alone,
  );
  try {
    if (!emptyManifest(manifest)) await push(on, manifest);
  } catch (error) {
    shared.broken = true;
    throw error;
  }
  if (shared.broken) throw new Error(RECYCLED);
  const base = shared.base!;
  const written = new Set(docs.map((doc) => `/knowledge/${doc.name}`));
  noteImports(shared, base, after.tree, written, only);
  shared.base = only === null ? after.tree : onlyBase(base, after.tree, only);
  shared.version++;
}
