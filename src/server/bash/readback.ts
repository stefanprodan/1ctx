// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// How a command's trees are read back after it ran, over a listing of
// entries rather than a filesystem, so every shell backend saves by
// the same rules. Pure: no database, no shell.

import {
  checkFile,
  checkNames,
  parseName,
  textFromBytes,
} from "../knowledge/rules.ts";
import { messageOf } from "../lib/errors.ts";
import { checkScratchNames, parseScratchName } from "./names.ts";
import { mountPath, normalizePath, prefixes, underKnowledge } from "./paths.ts";
import type { Answer, Changes, Job, ScratchEntry } from "./protocol.ts";

export type EntryKind = "file" | "dir" | "link" | "other";

// One path of the trees, absolute, its kind read without following a
// link. A file under /knowledge or /tmp carries its bytes. Under
// /uploads a file without bytes reads as changed, so a caller that
// knows a file differs need not fetch it. Under /mcp only the paths
// are judged.
export type TreeEntry = {
  path: string;
  kind: EntryKind;
  mode: number;
  bytes?: Uint8Array;
};

// what the rules read of the job
export type TreeMount = Pick<
  Job,
  | "docs"
  | "knowledge"
  | "scratch"
  | "uploads"
  | "kept"
  | "knowledgeFileBytes"
  | "subagent"
>;

// why a subagent's command that changed the shared trees saved nothing
export const READ_ONLY_TO_SUBAGENT =
  "/knowledge and /uploads are read-only to a subagent: write to /tmp";

const same = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b);

const byPath = (a: TreeEntry, b: TreeEntry) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

function bytesOf(entry: TreeEntry): Uint8Array {
  if (entry.bytes === undefined)
    throw new Error(`${entry.path} was listed without its bytes`);
  return entry.bytes;
}

// a command that ended at or past its deadline was cut, whatever exit the
// shell gave, so it is the deadline's 124 and saves nothing
export function exitAt(exitCode: number, endedAt: number, endsAt: number) {
  return endedAt >= endsAt ? 124 : exitCode;
}

// the docs and scratch a command changed: links and special files fail
// the save, every name keeps its tree's rule, and a mounted path gone
// is a delete. With the docs off nothing under /knowledge is read, so an
// empty mount never reads as every file deleted
export function treeChanges(
  entries: readonly TreeEntry[],
  mount: TreeMount,
): Omit<Changes, "cwd"> {
  const listing = [...entries].sort(byPath);
  for (let at = 1; at < listing.length; at++)
    if (listing[at]!.path === listing[at - 1]!.path)
      throw new Error(`${listing[at]!.path} was listed twice`);
  const root = listing.find((entry) => entry.path === "/tmp");
  if (root === undefined)
    throw new Error("ENOENT: no such file or directory, lstat '/tmp'");
  if (root.kind !== "dir") throw new Error("/tmp is not a directory");
  const mounted = new Map(mount.knowledge.map((file) => [file.name, file]));
  const temporary = new Map(mount.scratch.map((file) => [file.name, file]));
  const names: string[] = [];
  const scratchNames: string[] = [];
  const knowledge: Changes["knowledge"] = [];
  const written: ScratchEntry[] = [];
  for (const entry of listing) {
    const path = entry.path;
    if (!((mount.docs && underKnowledge(path)) || path.startsWith("/tmp/")))
      continue;
    if (entry.kind === "link" || entry.kind === "other")
      throw new Error(`${path} is not a regular file`);
    if (entry.kind === "dir") continue;
    if (path.startsWith("/tmp/")) {
      const name = parseScratchName(path.slice("/tmp/".length));
      scratchNames.push(name);
      const data = bytesOf(entry);
      const before = temporary.get(name);
      temporary.delete(name);
      if (
        before === undefined ||
        before.mode !== entry.mode ||
        !same(before.data, data)
      ) {
        // its own copy, so the reply's transfer detaches nothing else
        written.push({
          path: name,
          data: new Uint8Array(data),
          mode: entry.mode,
        });
      }
      continue;
    }
    const name = parseName(path.slice("/knowledge/".length));
    names.push(name);
    const before = mounted.get(name);
    const bytes = bytesOf(entry);
    mounted.delete(name);
    if (before !== undefined && same(before.data, bytes)) continue;
    const text = textFromBytes(bytes);
    checkFile(
      name,
      Buffer.byteLength(text),
      before?.data.byteLength ?? 0,
      mount,
    );
    knowledge.push({ name, text });
  }
  checkNames(names);
  checkScratchNames(scratchNames);
  for (const before of mounted.values()) {
    knowledge.push({ name: before.name, text: null });
  }
  return {
    knowledge,
    written,
    removed: [...temporary.keys()],
  };
}

// an empty folder under /knowledge loses nothing worth a notice
const docsWritten = (entries: readonly TreeEntry[]) =>
  entries.some((entry) => underKnowledge(entry.path) && entry.kind !== "dir");

// a write beside the mounted repositories lands in the base, and goes;
// a folder alone is no write, as the shell makes its cwd's
const reposWritten = (entries: readonly TreeEntry[]) =>
  entries.some(
    (entry) => entry.path.startsWith("/repos/") && entry.kind !== "dir",
  );

function uploadsChanged(
  entries: readonly TreeEntry[],
  uploads: TreeMount["uploads"],
): boolean {
  const root = entries.find((entry) => entry.path === "/uploads");
  if (root === undefined || root.kind !== "dir") return true;
  const expected = new Map<string, Uint8Array | null>();
  for (const file of uploads) {
    const path = `/uploads/${file.name}`;
    for (const folder of prefixes(path).slice(1, -1))
      expected.set(folder, null);
    expected.set(path, file.data);
  }
  for (const entry of entries) {
    if (!entry.path.startsWith("/uploads/")) continue;
    const before = expected.get(entry.path);
    // a path listed twice finds nothing the second time
    if (before === undefined || entry.kind === "link") return true;
    if (before === null) {
      if (entry.kind !== "dir") return true;
    } else if (
      entry.kind !== "file" ||
      entry.bytes === undefined ||
      !same(before, entry.bytes)
    ) {
      return true;
    }
    expected.delete(entry.path);
  }
  return expected.size !== 0;
}

// names alone: a changed file under /mcp goes unnoticed and is
// discarded all the same
function keptChanged(
  entries: readonly TreeEntry[],
  kept: readonly string[],
): boolean {
  const expected = new Set<string>();
  for (const path of kept) for (const at of prefixes(path)) expected.add(at);
  let seen = 0;
  for (const entry of entries) {
    if (entry.path !== "/mcp" && !entry.path.startsWith("/mcp/")) continue;
    if (!expected.has(entry.path)) return true;
    seen++;
  }
  return seen !== expected.size;
}

// A subagent's command that changed /knowledge or /uploads saves
// nothing, /tmp included; with the docs off treeChanges() reads no
// /knowledge, so a file written there counts here. The server refuses
// doc changes on its own.
export function sharedChange(
  entries: readonly TreeEntry[],
  mount: TreeMount,
  changes: Pick<Changes, "knowledge">,
): string | null {
  return changes.knowledge.length > 0 ||
    (!mount.docs && docsWritten(entries)) ||
    uploadsChanged(entries, mount.uploads)
    ? READ_ONLY_TO_SUBAGENT
    : null;
}

// the discard notices, before the start notice
export function discardNotices(
  entries: readonly TreeEntry[],
  mount: TreeMount,
): string {
  let notice = "";
  if (reposWritten(entries)) {
    notice =
      "changes under /repos were discarded: copy a file to /tmp to change it\n";
  }
  if (keptChanged(entries, mount.kept)) {
    notice =
      "changes under /mcp were discarded: copy a file to /tmp to change it\n" +
      notice;
  }
  if (uploadsChanged(entries, mount.uploads)) {
    notice =
      "changes under /uploads were discarded: copy a file to /tmp to change it\n" +
      notice;
  }
  if (!mount.docs && docsWritten(entries)) {
    notice =
      "changes under /knowledge were discarded: the project docs are off\n" +
      notice;
  }
  return notice;
}

const home = (docs: boolean) => (docs ? "/knowledge" : "/tmp");

// The cwd the server takes, as mountPath allows it, or home. Whether a
// path is a folder is the caller's to say: a listing answers for the
// trees it holds, the mounted repositories for /repos.
export async function savedCwd(
  pwd: string | undefined,
  docs: boolean,
  isDirectory: (path: string) => boolean | Promise<boolean>,
): Promise<string> {
  if (pwd === undefined || !pwd.startsWith("/")) return home(docs);
  const path = normalizePath(pwd);
  if (!mountPath(path) || (!docs && underKnowledge(path))) return home(docs);
  return (await isDirectory(path)) ? path : home(docs);
}

// what a command's result opens with when it could not start where the
// last one ended; a cwd in the docs while they are off moves without a
// word
export function startNotice(saved: string, cwd: string, docs: boolean) {
  return cwd !== saved && (docs || !underKnowledge(saved))
    ? `started in ${cwd}: ${saved} no longer exists\n`
    : "";
}

export type ReadBack = Pick<Answer, "changes" | "refused">;

// After the command, its trees and cwd as the server is answered: an
// exit at a deadline or limit reads nothing back, a refused tree saves
// nothing and says why, and a cwd in the docs while they are off waits
// in /tmp until they are on again, unless the command moved.
export async function readBack(
  entries: readonly TreeEntry[],
  mount: TreeMount & Pick<Job, "cwd">,
  ran: {
    exitCode: number;
    // whether the shell stopped the command; an exit 124 or 126 when
    // not given
    stopped?: boolean;
    // where the command started, from savedCwd()
    start: string;
    // the shell's PWD when it ended
    pwd: string | undefined;
    isDirectory: (path: string) => boolean | Promise<boolean>;
  },
): Promise<ReadBack> {
  if (ran.stopped ?? (ran.exitCode === 124 || ran.exitCode === 126))
    return { changes: null, refused: null };
  let changes: Omit<Changes, "cwd">;
  try {
    changes = treeChanges(entries, mount);
  } catch (error) {
    return { changes: null, refused: messageOf(error) };
  }
  const shared = mount.subagent ? sharedChange(entries, mount, changes) : null;
  if (shared !== null) return { changes: null, refused: shared };
  const after = await savedCwd(ran.pwd, mount.docs, ran.isDirectory);
  return {
    changes: {
      ...changes,
      cwd:
        !mount.docs && underKnowledge(mount.cwd) && after === ran.start
          ? mount.cwd
          : after,
    },
    refused: null,
  };
}
