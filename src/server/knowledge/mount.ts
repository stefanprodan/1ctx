// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A disposable mount keeps shared text and session scratch atomic without
// holding a database transaction while the shell runs.

import { Bash, decodeBytesToUtf8, InMemoryFs, stdoutAsBytes } from "just-bash";
import type { KnowledgeAuthor } from "../../shared/contracts/knowledge.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import { checkFile, checkNames } from "./check.ts";
import { type Change, commit, type ScratchCommit } from "./commit.ts";
import { KNOWLEDGE_COMMANDS } from "./limits.ts";
import { failed, output } from "./output.ts";
import { parseName } from "./parse.ts";
import { acquire, acquireSession } from "./queue.ts";
import type { Scratch, ScratchStore } from "./scratch.ts";
import { type KnowledgeRow, type KnowledgeStore, summary } from "./store.ts";
import { textFromBytes } from "./text.ts";

export type CommandCaps = { callTimeoutMs: number; resultCut: number };
export type CommandResult = {
  content: string;
  error: boolean;
  tail?: number;
};
type MountDeps = {
  db: Db;
  store: KnowledgeStore;
  scratch: ScratchStore;
  clock: Clock;
  current(): KnowledgeCaps;
};

async function diff(
  fs: InMemoryFs,
  rows: readonly KnowledgeRow[],
  scratch: Scratch,
  caps: KnowledgeCaps,
): Promise<{
  knowledge: Change[];
  scratch: Omit<ScratchCommit, "sessionId" | "before">;
}> {
  const mounted = new Map(rows.map((file) => [file.name, file]));
  const temporary = new Map(scratch.entries.map((file) => [file.path, file]));
  const names: string[] = [];
  const scratchNames: string[] = [];
  const changes: Change[] = [];
  const written: Scratch["entries"] = [];
  let scratchBytes = 0;
  const root = await fs.lstat("/tmp");
  if (!root.isDirectory || root.isSymbolicLink)
    throw new Error("/tmp is not a directory");
  const paths = fs
    .getAllPaths()
    .filter(
      (path) =>
        path === "/knowledge" ||
        path.startsWith("/knowledge/") ||
        path.startsWith("/tmp/"),
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
      scratchBytes += data.byteLength;
      const before = temporary.get(name);
      temporary.delete(name);
      if (
        before === undefined ||
        before.mode !== stat.mode ||
        !Buffer.from(before.data).equals(data)
      ) {
        written.push({ path: name, data, mode: stat.mode });
      }
      continue;
    }
    const name = parseName(path.slice("/knowledge/".length));
    names.push(name);
    const before = mounted.get(name);
    const bytes = await fs.readFileBuffer(path);
    mounted.delete(name);
    if (before !== undefined && Buffer.from(before.text).equals(bytes))
      continue;
    const text = textFromBytes(bytes);
    checkFile(name, Buffer.byteLength(text), before?.bytes ?? 0, caps);
    changes.push({ name, before: before ? summary(before) : null, text });
  }
  checkNames(names);
  checkNames(scratchNames);
  for (const before of mounted.values()) {
    changes.push({ name: before.name, before: summary(before), text: null });
  }
  return {
    knowledge: changes,
    scratch: {
      changes: { written, removed: [...temporary.keys()], cwd: "/knowledge" },
      totals: { files: scratchNames.length, bytes: scratchBytes },
    },
  };
}

async function directory(fs: InMemoryFs, path: string): Promise<boolean> {
  return (await fs.exists(path)) && (await fs.stat(path)).isDirectory;
}

async function savedCwd(
  fs: InMemoryFs,
  pwd: string | undefined,
): Promise<string> {
  if (
    pwd === undefined ||
    !pwd.startsWith("/") ||
    Buffer.byteLength(pwd) > 256 ||
    /\p{Cc}/u.test(pwd)
  )
    return "/knowledge";
  const path = fs.resolvePath("/", pwd);
  if (
    path !== "/knowledge" &&
    path !== "/tmp" &&
    !path.startsWith("/knowledge/") &&
    !path.startsWith("/tmp/")
  )
    return "/knowledge";
  return (await directory(fs, path)) ? path : "/knowledge";
}

export async function run(
  deps: MountDeps,
  projectId: string,
  sessionId: string,
  author: KnowledgeAuthor,
  command: string,
  caps: CommandCaps,
  signal: AbortSignal,
): Promise<CommandResult> {
  const started = Date.now();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error("command timed out")),
    caps.callTimeoutMs,
  );
  const combined = AbortSignal.any([signal, deadline.signal]);
  let release: (() => void) | undefined;
  let releaseSession: (() => void) | undefined;
  let notice = "";
  try {
    releaseSession = await acquireSession(sessionId, combined);
    release = await acquire(combined);
    combined.throwIfAborted();
    const storage = deps.current();
    const rows = deps.store.read(projectId);
    const scratch = deps.scratch.read(sessionId);
    // A lowered cap still permits deleting or shrinking the mounted base.
    const projectBytes = Math.max(
      storage.knowledgeProjectBytes,
      rows.reduce((bytes, row) => bytes + row.bytes, 0),
    );
    const mountBytes =
      projectBytes +
      Math.max(storage.scratchBytes, scratch.bytes) +
      2 * 1024 * 1024;
    const fs = new InMemoryFs({}, { maxTotalBytes: mountBytes });
    fs.mkdirSync("/knowledge", { recursive: true });
    fs.mkdirSync("/tmp", { recursive: true });
    for (const row of rows)
      fs.writeFileSync(`/knowledge/${row.name}`, row.text);
    for (const file of scratch.entries)
      fs.writeFileSync(`/tmp/${file.path}`, file.data, undefined, {
        mode: file.mode,
      });
    const cwd = (await directory(fs, scratch.cwd)) ? scratch.cwd : "/knowledge";
    if (cwd !== scratch.cwd)
      notice = `started in /knowledge: ${scratch.cwd} no longer exists\n`;
    const ioBytes = Math.max(
      4 * caps.resultCut,
      storage.scratchBytes,
      storage.knowledgeFileBytes,
    );
    const bash = new Bash({
      fs,
      cwd,
      commands: [...KNOWLEDGE_COMMANDS],
      defenseInDepth: true,
      executionLimits: {
        maxExecutionTimeMs: Math.max(
          1,
          caps.callTimeoutMs - (Date.now() - started),
        ),
        maxOutputSize: ioBytes,
        maxHeredocSize: storage.knowledgeFileBytes,
        maxStringLength: ioBytes,
        maxSourceBytes: 64 * 1024,
        maxCommandCount: 100_000,
        maxLoopIterations: 100_000,
        maxAwkIterations: 100_000,
        maxSedIterations: 100_000,
        maxJqIterations: 100_000,
        maxLiveBytes: 4 * mountBytes,
        maxInputBytes: ioBytes,
        maxArchiveBytes: 4 * mountBytes,
        maxArchiveCompressedBytes: 4 * mountBytes,
        maxArchiveEntryBytes: 4 * mountBytes,
        maxTraversalEntries: Math.max(1000, fs.getAllPaths().length * 4),
      },
    });
    const result = await bash.exec(command, {
      rawScript: true,
      signal: combined,
    });
    const stdout = decodeBytesToUtf8(stdoutAsBytes(result));
    combined.throwIfAborted();
    if (result.exitCode === 124 || result.exitCode === 126) {
      const printed = output(
        stdout,
        `${result.stderr}\nnothing saved: command stopped at a deadline or limit`,
        result.exitCode,
        [],
        caps.resultCut - notice.length,
      );
      return {
        ...printed,
        content: notice + printed.content,
        error: true,
      };
    }
    const changes = await diff(fs, rows, scratch, storage);
    changes.scratch.changes.cwd = await savedCwd(fs, result.env.PWD);
    combined.throwIfAborted();
    const printed = commit(
      deps,
      projectId,
      author,
      changes.knowledge,
      { sessionId, before: scratch, ...changes.scratch },
      { stdout, stderr: result.stderr, exitCode: result.exitCode },
      caps.resultCut - notice.length,
      combined,
      deps.clock(),
    );
    return {
      ...printed,
      content: notice + printed.content,
      error: result.exitCode !== 0,
    };
  } catch (error) {
    const result = failed(error, caps.resultCut - notice.length);
    return { ...result, content: notice + result.content };
  } finally {
    clearTimeout(timer);
    release?.();
    releaseSession?.();
  }
}
