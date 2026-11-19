// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The just-bash tree as a listing for the read-back rules (readback.ts); /repos
// is mounted over it, never listed.

import type { BashOptions, IFileSystem, InMemoryFs } from "just-bash";
import { INPUT_PASSES } from "./commands.ts";
import { prefixes, underKnowledge, underRoot } from "./paths.ts";
import type { Job } from "./protocol.ts";
import type { EntryKind, TreeEntry } from "./readback.ts";

const read = (path: string, docs: boolean) =>
  path.startsWith("/tmp/") ||
  path.startsWith("/uploads/") ||
  (docs && underKnowledge(path));

// Every path of the trees in the base, with the bytes the rules read.
// Nothing under /mcp is stated, since a stat would load a lazy file
// and the rules judge only names there: a path is listed by the shape
// it was mounted with, or as other when the mount never held it.
export async function listTree(fs: InMemoryFs, job: Job): Promise<TreeEntry[]> {
  const kept = new Map<string, EntryKind>();
  for (const path of job.kept) {
    for (const folder of prefixes(path).slice(0, -1)) kept.set(folder, "dir");
    kept.set(path, "file");
  }
  const entries: TreeEntry[] = [];
  for (const path of fs.getAllPaths()) {
    if (!underRoot(path)) continue;
    if (path === "/mcp" || path.startsWith("/mcp/")) {
      entries.push({ path, kind: kept.get(path) ?? "other", mode: 0 });
      continue;
    }
    const stat = await fs.lstat(path);
    const kind: EntryKind = stat.isSymbolicLink
      ? "link"
      : stat.isDirectory
        ? "dir"
        : stat.isFile
          ? "file"
          : "other";
    entries.push(
      kind === "file" && read(path, job.docs)
        ? { path, kind, mode: stat.mode, bytes: await fs.readFileBuffer(path) }
        : { path, kind, mode: stat.mode },
    );
  }
  return entries;
}

// a folder in the mounted tree, /repos included, links followed
export async function isDirectoryIn(
  fs: IFileSystem,
  path: string,
): Promise<boolean> {
  return (await fs.exists(path)) && (await fs.stat(path)).isDirectory;
}

export function executionLimits(
  job: Job,
  fs: InMemoryFs,
  remainingMs: number,
): NonNullable<BashOptions["executionLimits"]> {
  // a whole repository fits one walk, and its bytes count as mounted
  const repoEntries = job.repos.reduce(
    (sum, repo) => sum + repo.files + repo.dirs,
    0,
  );
  const repoBytes = job.repos.reduce((sum, repo) => sum + repo.bytes, 0);
  return {
    maxExecutionTimeMs: Math.max(1, remainingMs),
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
    maxInputBytes: INPUT_PASSES * (job.mountBytes + repoBytes),
    maxArchiveBytes: 4 * job.mountBytes,
    maxArchiveCompressedBytes: 4 * job.mountBytes,
    maxArchiveEntryBytes: 4 * job.mountBytes,
    maxTraversalEntries:
      Math.max(1000, fs.getAllPaths().length * 4) + repoEntries,
  };
}
