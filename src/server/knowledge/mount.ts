// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Bash, decodeBytesToUtf8, InMemoryFs, stdoutAsBytes } from "just-bash";
import type { KnowledgeAuthor } from "../../shared/contracts/knowledge.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import { checkFile, checkNames } from "./check.ts";
import { type Change, commit } from "./commit.ts";
import { KNOWLEDGE_COMMANDS } from "./limits.ts";
import { failed, output } from "./output.ts";
import { parseName } from "./parse.ts";
import { acquire } from "./queue.ts";
import { type KnowledgeRow, type KnowledgeStore, summary } from "./store.ts";
import { textFromBytes } from "./text.ts";

export type CommandCaps = { callTimeoutMs: number; resultCut: number };
export type CommandResult = { content: string; error: boolean };
type MountDeps = {
  db: Db;
  store: KnowledgeStore;
  clock: Clock;
  current(): KnowledgeCaps;
};

async function diff(
  fs: InMemoryFs,
  rows: readonly KnowledgeRow[],
  caps: KnowledgeCaps,
): Promise<Change[]> {
  const mounted = new Map(rows.map((file) => [file.name, file]));
  const names: string[] = [];
  const changes: Change[] = [];
  const paths = fs
    .getAllPaths()
    .filter((path) => path === "/knowledge" || path.startsWith("/knowledge/"))
    .sort();
  for (const path of paths) {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink || (!stat.isFile && !stat.isDirectory)) {
      throw new Error(`${path} is not a regular file`);
    }
    if (stat.isDirectory) continue;
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
  for (const before of mounted.values()) {
    changes.push({ name: before.name, before: summary(before), text: null });
  }
  return changes;
}

export async function run(
  deps: MountDeps,
  projectId: string,
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
  try {
    release = await acquire(combined);
    combined.throwIfAborted();
    const storage = deps.current();
    const rows = deps.store.read(projectId);
    // A lowered cap still permits deleting or shrinking the mounted base.
    const projectBytes = Math.max(
      storage.knowledgeProjectBytes,
      rows.reduce((bytes, row) => bytes + row.bytes, 0),
    );
    const fs = new InMemoryFs(
      Object.fromEntries(
        rows.map((row) => [`/knowledge/${row.name}`, row.text]),
      ),
      { maxTotalBytes: projectBytes + 2 * 1024 * 1024 },
    );
    fs.mkdirSync("/knowledge", { recursive: true });
    const bash = new Bash({
      fs,
      cwd: "/knowledge",
      commands: [...KNOWLEDGE_COMMANDS],
      defenseInDepth: true,
      executionLimits: {
        maxExecutionTimeMs: Math.max(
          1,
          caps.callTimeoutMs - (Date.now() - started),
        ),
        maxOutputSize: 4 * caps.resultCut,
        maxHeredocSize: storage.knowledgeFileBytes,
        maxStringLength: storage.knowledgeFileBytes,
        maxSourceBytes: 64 * 1024,
        maxCommandCount: 100_000,
        maxLoopIterations: 100_000,
        maxAwkIterations: 100_000,
        maxSedIterations: 100_000,
        maxJqIterations: 100_000,
        maxLiveBytes: 4 * projectBytes,
        maxInputBytes: 4 * projectBytes,
        maxArchiveBytes: 4 * projectBytes,
        maxArchiveCompressedBytes: 4 * projectBytes,
        maxArchiveEntryBytes: 4 * projectBytes,
        maxTraversalEntries: Math.max(1000, Math.ceil(projectBytes / 64) * 4),
      },
    });
    const result = await bash.exec(command, {
      rawScript: true,
      signal: combined,
    });
    const stdout = decodeBytesToUtf8(stdoutAsBytes(result));
    combined.throwIfAborted();
    if (result.exitCode === 124 || result.exitCode === 126) {
      return {
        content: output(
          stdout,
          `${result.stderr}\nnothing saved: command stopped at a deadline or limit`,
          result.exitCode,
          [],
          caps.resultCut,
        ),
        error: true,
      };
    }
    const changes = await diff(fs, rows, storage);
    combined.throwIfAborted();
    const content =
      changes.length === 0
        ? output(stdout, result.stderr, result.exitCode, [], caps.resultCut)
        : commit(
            deps,
            projectId,
            author,
            changes,
            { stdout, stderr: result.stderr, exitCode: result.exitCode },
            caps.resultCut,
            combined,
            deps.clock(),
          );
    return { content, error: result.exitCode !== 0 };
  } catch (error) {
    return failed(error, caps.resultCut);
  } finally {
    clearTimeout(timer);
    release?.();
  }
}
