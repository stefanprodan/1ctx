// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A walk read as the read-back rules list a tree: every entry with its
// kind and mode, the bytes of a file under /knowledge or /tmp from the
// rows when its hash is unchanged and pulled when it is not, an upload's
// only when unchanged. What a command changed where nothing commits is
// marked, so its sandbox is recycled. A name that would be saved must
// be UTF-8, as every name the built-in shell makes is, and must not
// hold a key the command was handed. The records a command leaves (its
// cwd, open's copies) are hostile, and every one is checked.

import { textFromBytes } from "../../shared/knowledge.ts";
import type {
  CommandCredential,
  Job,
  OpenedRecord,
  TreeEntry,
} from "../bash/index.ts";
import {
  escapedForms,
  MAX_OPENS_PER_COMMAND,
  openedRecord,
  underKnowledge,
} from "../bash/index.ts";
import type { Held, Wanted } from "./baseline.ts";
import { StepFailure } from "./execs.ts";
import { escapePath, pathOf, unescapePath } from "./frames.ts";
import { RECORDS, recordPaths } from "./helpers.ts";
import type { PullFrame } from "./pull.ts";
import type { WalkEntry } from "./walk.ts";

const KINDS = { d: "dir", f: "file", l: "link", o: "other" } as const;

export type Readout = {
  entries: TreeEntry[];
  // the folders listed, for the cwd
  folders: Set<string>;
  // the walked tree, for the normalization after a commit
  held: Held;
  // escaped paths whose bytes must be pulled, each with its entry
  pulls: Map<string, { entry: TreeEntry; walked: WalkEntry }>;
  // a change under /uploads, /mcp or a docs-off /knowledge
  discarded: boolean;
};

const keptOnly = (path: string, job: Job) =>
  path === "/uploads" ||
  path.startsWith("/uploads/") ||
  path === "/mcp" ||
  path.startsWith("/mcp/") ||
  (!job.docs && underKnowledge(path));

// what a commit would save: a doc while docs are on, any scratch file
const saved = (path: string, job: Job) =>
  (job.docs && underKnowledge(path)) || path.startsWith("/tmp/");

export function readout(
  walked: readonly WalkEntry[],
  job: Job,
  wanted: Wanted,
  credentials: readonly CommandCredential[] = [],
): Readout {
  // every spelling the scrub replaces, so a name is held to the same
  const forms = credentials.flatMap((credential) =>
    "key" in credential ? escapedForms(credential.key) : [],
  );
  const entries: TreeEntry[] = [];
  const folders = new Set<string>();
  const held: Held = new Map();
  const pulls: Readout["pulls"] = new Map();
  let discarded = false;
  const seen = new Set<string>();
  for (const at of walked) {
    const { path } = at;
    // read lossily, the name would commit under another spelling
    if (!at.unicode && saved(path, job))
      throw new StepFailure("walk", "unicode");
    // an echoed key a command wrote into a name is never stored
    if (saved(path, job) && forms.some((form) => path.includes(form)))
      throw new StepFailure("walk", "credential");
    const kind = KINDS[at.type];
    const top = path.split("/").length === 2;
    const want = wanted.tree.get(path);
    const same =
      want !== undefined &&
      want.kind === kind &&
      want.mode === at.mode &&
      (want.kind !== "file" || want.sha === at.sha256);
    // the time pushed, while the entry is as pushed: the walk reads no
    // time, so a time a command changed on an unchanged entry stays
    if (!top)
      held.set(path, {
        kind,
        mode: at.mode,
        mtime: same ? want.mtime : null,
        sha: at.sha256,
      });
    // a bare /mcp is the image's, which the built-in shell never makes
    if (path === "/mcp" && job.kept.length === 0) continue;
    if (kind === "dir") folders.add(path);
    if (!top && keptOnly(path, job)) {
      seen.add(path);
      if (!same) discarded = true;
    }
    const entry: TreeEntry = { path, kind, mode: at.mode };
    entries.push(entry);
    if (kind !== "file") continue;
    const sameBytes = want?.kind === "file" && want.sha === at.sha256;
    if (sameBytes) {
      const data = wanted.bytes.get(path);
      if (data !== undefined) entry.bytes = data;
      continue;
    }
    // a changed upload reads as changed without its bytes, and /mcp is
    // judged by names alone
    if (saved(path, job)) pulls.set(at.escaped, { entry, walked: at });
  }
  for (const path of wanted.tree.keys())
    if (keptOnly(path, job) && !seen.has(path)) discarded = true;
  return { entries, folders, held, pulls, discarded };
}

// each pulled file's bytes, which must be what the walk hashed
export function fill(out: Readout, frames: readonly PullFrame[]): void {
  for (const frame of frames) {
    const pending = out.pulls.get(frame.escaped);
    if (pending === undefined) continue;
    if (
      frame.missing ||
      frame.sha256 !== pending.walked.sha256 ||
      frame.mode !== pending.walked.mode
    )
      throw new StepFailure("pull", "mismatch");
    pending.entry.bytes = frame.data;
  }
  for (const pending of out.pulls.values())
    if (pending.entry.bytes === undefined)
      throw new StepFailure("pull", "missing");
}

const strict = new TextDecoder("utf-8", { fatal: true });

// the escaped paths of a command's records under RECORDS, relative
export function recordRequests(id: string, open: boolean): string[] {
  const { cwd, opened } = recordPaths(id);
  const out = [escapePath(cwd)];
  if (open)
    for (let n = 1; n <= MAX_OPENS_PER_COMMAND; n++)
      out.push(escapePath(`${opened}/${n}`), escapePath(`${opened}/${n}.path`));
  return out;
}

export const RECORD_ROOTS = [RECORDS];

// a path's bytes at Linux's PATH_MAX
export const PATH_BYTES = 4096;

// past any cwd or opened path the rules keep (/tmp/ and a 4095-byte
// name), far under a file's bound
const RECORD_PATH_BYTES = 2 * PATH_BYTES;

// The records that hold a path, each bounded to one: the cwd raw, an
// opened copy's name escaped with its newline. Read with a file's
// bound, a hostile record would reach the split and unescape at any size.
export function recordBounds(id: string, open: boolean): Map<string, number> {
  const { cwd, opened } = recordPaths(id);
  const out = new Map([[escapePath(cwd), RECORD_PATH_BYTES]]);
  if (open)
    for (let n = 1; n <= MAX_OPENS_PER_COMMAND; n++)
      out.set(escapePath(`${opened}/${n}.path`), 3 * RECORD_PATH_BYTES + 1);
  return out;
}

// The final cwd the wrapper wrote, or undefined: a record missing, not
// UTF-8 or empty keeps the cwd the command started in.
export function recordedCwd(
  id: string,
  frames: readonly PullFrame[],
): string | undefined {
  const want = escapePath(recordPaths(id).cwd);
  const frame = frames.find((each) => each.escaped === want);
  if (frame === undefined || frame.missing) return undefined;
  try {
    const text = strict.decode(frame.data);
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

// open's copies, in the order open numbered them, each made again from
// its text as open makes it; mount.ts holds them to open's checks
export function openedOf(
  id: string,
  frames: readonly PullFrame[],
  visuals: boolean,
): OpenedRecord[] {
  const { opened } = recordPaths(id);
  const byPath = new Map(frames.map((frame) => [frame.escaped, frame]));
  const out: OpenedRecord[] = [];
  for (let n = 1; n <= MAX_OPENS_PER_COMMAND; n++) {
    const copy = byPath.get(escapePath(`${opened}/${n}`));
    const named = byPath.get(escapePath(`${opened}/${n}.path`));
    if (copy === undefined || named === undefined) continue;
    if (copy.missing || named.missing) continue;
    let line: string;
    try {
      line = strict.decode(named.data);
    } catch {
      throw new StepFailure("records", "name");
    }
    const raw = line.endsWith("\n") ? unescapePath(line.slice(0, -1)) : null;
    const path = raw === null ? null : pathOf(raw);
    if (path === null || !path.unicode)
      throw new StepFailure("records", "name");
    let text: string;
    try {
      text = textFromBytes(copy.data);
    } catch {
      throw new StepFailure("records", "text");
    }
    out.push(openedRecord(path.path, text, visuals));
  }
  return out;
}
