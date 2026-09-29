// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The mounted tree, read back in the command worker: what changed under
// /knowledge and /tmp against the posted bytes, the discard notices for
// the read-only trees, and the cwd the next command starts in.

import type { BashOptions, InMemoryFs } from "just-bash";
import { checkFile, checkNames } from "./check.ts";
import { INTERPRETER_MARGIN_MS } from "./commands.ts";
import { underKnowledge } from "./open.ts";
import { parseName } from "./parse.ts";
import type { Changes, Job, MountFile, ScratchEntry } from "./protocol.ts";
import { textFromBytes } from "./text.ts";

const same = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b);

export async function diff(
  fs: InMemoryFs,
  job: Job,
): Promise<Omit<Changes, "cwd">> {
  const mounted = new Map(job.knowledge.map((file) => [file.name, file]));
  const temporary = new Map(job.scratch.map((file) => [file.name, file]));
  const names: string[] = [];
  const scratchNames: string[] = [];
  const knowledge: Changes["knowledge"] = [];
  const written: ScratchEntry[] = [];
  const root = await fs.lstat("/tmp");
  if (!root.isDirectory || root.isSymbolicLink)
    throw new Error("/tmp is not a directory");
  const paths = fs
    .getAllPaths()
    // with the docs off nothing under /knowledge is read, so an empty
    // mount never reads as every file deleted
    .filter(
      (path) => (job.docs && underKnowledge(path)) || path.startsWith("/tmp/"),
    )
    .sort();
  for (const path of paths) {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink || (!stat.isFile && !stat.isDirectory)) {
      throw new Error(`${path} is not a regular file`);
    }
    if (stat.isDirectory) continue;
    if (path.startsWith("/tmp/")) {
      const name = parseName(path.slice("/tmp/".length));
      scratchNames.push(name);
      const data = await fs.readFileBuffer(path);
      const before = temporary.get(name);
      temporary.delete(name);
      if (
        before === undefined ||
        before.mode !== stat.mode ||
        !same(before.data, data)
      ) {
        // its own copy, so the reply's transfer detaches nothing else
        written.push({
          path: name,
          data: new Uint8Array(data),
          mode: stat.mode,
        });
      }
      continue;
    }
    const name = parseName(path.slice("/knowledge/".length));
    names.push(name);
    const before = mounted.get(name);
    const bytes = await fs.readFileBuffer(path);
    mounted.delete(name);
    if (before !== undefined && same(before.data, bytes)) continue;
    const text = textFromBytes(bytes);
    checkFile(name, Buffer.byteLength(text), before?.data.byteLength ?? 0, job);
    knowledge.push({ name, text });
  }
  checkNames(names);
  checkNames(scratchNames);
  for (const before of mounted.values()) {
    knowledge.push({ name: before.name, text: null });
  }
  return {
    knowledge,
    written,
    removed: [...temporary.keys()],
  };
}

async function directory(fs: InMemoryFs, path: string): Promise<boolean> {
  return (await fs.exists(path)) && (await fs.stat(path)).isDirectory;
}

// an empty folder under /knowledge loses nothing worth a notice
async function docsWritten(fs: InMemoryFs): Promise<boolean> {
  for (const path of fs.getAllPaths())
    if (underKnowledge(path) && !(await fs.lstat(path)).isDirectory)
      return true;
  return false;
}

async function uploadsChanged(
  fs: InMemoryFs,
  uploads: readonly MountFile[],
): Promise<boolean> {
  const paths = fs.getAllPaths().sort();
  if (!paths.includes("/uploads")) return true;
  const root = await fs.lstat("/uploads");
  if (!root.isDirectory || root.isSymbolicLink) return true;
  const expected = new Map<string, Uint8Array | null>();
  for (const file of uploads) {
    const parts = file.name.split("/");
    for (let end = 1; end < parts.length; end++)
      expected.set(`/uploads/${parts.slice(0, end).join("/")}`, null);
    expected.set(`/uploads/${file.name}`, file.data);
  }
  for (const path of paths) {
    if (!path.startsWith("/uploads/")) continue;
    const before = expected.get(path);
    if (before === undefined) return true;
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink) return true;
    if (before === null) {
      if (!stat.isDirectory) return true;
    } else if (!stat.isFile || !same(before, await fs.readFileBuffer(path))) {
      return true;
    }
    expected.delete(path);
  }
  return expected.size !== 0;
}

// Names alone, from the tree's own list: a stat would load every lazy
// file to size it. A changed file under /mcp goes unnoticed and is
// discarded all the same.
function keptChanged(fs: InMemoryFs, kept: readonly string[]): boolean {
  const expected = new Set<string>();
  for (const path of kept) {
    const parts = path.split("/").filter(Boolean);
    for (let end = 1; end <= parts.length; end++)
      expected.add(`/${parts.slice(0, end).join("/")}`);
  }
  let seen = 0;
  for (const path of fs.getAllPaths()) {
    if (path !== "/mcp" && !path.startsWith("/mcp/")) continue;
    if (!expected.has(path)) return true;
    seen++;
  }
  return seen !== expected.size;
}

// the discard notices, before the start notice
export async function notices(fs: InMemoryFs, job: Job): Promise<string> {
  let notice = "";
  if (keptChanged(fs, job.kept)) {
    notice =
      "changes under /mcp were discarded: copy a file to /tmp to change it\n" +
      notice;
  }
  if (await uploadsChanged(fs, job.uploads)) {
    notice =
      "changes under /uploads were discarded: copy a file to /tmp to change it\n" +
      notice;
  }
  if (!job.docs && (await docsWritten(fs))) {
    notice =
      "changes under /knowledge were discarded: the project docs are off\n" +
      notice;
  }
  return notice;
}

const home = (docs: boolean) => (docs ? "/knowledge" : "/tmp");

export async function savedCwd(
  fs: InMemoryFs,
  pwd: string | undefined,
  docs: boolean,
): Promise<string> {
  if (
    pwd === undefined ||
    !pwd.startsWith("/") ||
    Buffer.byteLength(pwd) > 256 ||
    /\p{Cc}/u.test(pwd)
  )
    return home(docs);
  const path = fs.resolvePath("/", pwd);
  if (
    !(docs && underKnowledge(path)) &&
    path !== "/tmp" &&
    path !== "/uploads" &&
    path !== "/mcp" &&
    !path.startsWith("/tmp/") &&
    !path.startsWith("/uploads/") &&
    !path.startsWith("/mcp/")
  )
    return home(docs);
  return (await directory(fs, path)) ? path : home(docs);
}

export function executionLimits(
  job: Job,
  fs: InMemoryFs,
  remainingMs: number,
): NonNullable<BashOptions["executionLimits"]> {
  return {
    maxExecutionTimeMs: Math.max(1, remainingMs - INTERPRETER_MARGIN_MS),
    maxOutputSize: job.ioBytes,
    maxHeredocSize: job.knowledgeFileBytes,
    maxStringLength: job.ioBytes,
    maxSourceBytes: 64 * 1024,
    maxCommandCount: job.iterations,
    maxLoopIterations: job.iterations,
    maxAwkIterations: job.iterations,
    maxSedIterations: job.iterations,
    maxJqIterations: job.iterations,
    maxLiveBytes: 4 * job.mountBytes,
    maxInputBytes: job.ioBytes,
    maxArchiveBytes: 4 * job.mountBytes,
    maxArchiveCompressedBytes: 4 * job.mountBytes,
    maxArchiveEntryBytes: 4 * job.mountBytes,
    maxTraversalEntries: Math.max(1000, fs.getAllPaths().length * 4),
  };
}
