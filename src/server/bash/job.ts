// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A command's job, read from the rows with the identities of what it
// read, so the commit and the shell both know what was mounted.

import type { WebSnapshot } from "../../shared/web.ts";
import type { Db } from "../db/index.ts";
import type { MountedDoc, MountedUploads } from "../knowledge/index.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import { COMMAND_ITERATIONS } from "./commands.ts";
import type { CommitDocs } from "./commit.ts";
import type { CommandCredential } from "./credentials.ts";
import { type KeptEntry, listKept } from "./kept.ts";
import { mountableScratch } from "./names.ts";
import type { Job, JobRepo } from "./protocol.ts";
import type { Scratch, ScratchStore } from "./scratch.ts";
import type { Mounted, StoredBytes } from "./shell.ts";
import { type Workspace, workspaceSession } from "./workspace.ts";

// the repositories a send mounted, read-only under /repos
export type CommandRepos = {
  mounts: readonly JobRepo[];
  fileBytes: number;
  // what the command's result opens with: a repository left out and why
  notice: string;
};
export type CommandCaps = {
  callTimeoutMs: number;
  // what a command under the sandbox shell may run instead, given by a
  // tool that offered the sandbox's words
  sandboxCommandMs?: number;
  resultCut: number;
  visuals: boolean;
  // false while the send has the project docs off: no /knowledge
  knowledge: boolean;
  repos?: CommandRepos;
  // a subagent's command: /uploads is its parent's, nothing is opened,
  // and in a shell of its own nothing under /knowledge or /uploads may
  // change. workspace is its parent's, whose shell a shared one runs in
  subagent?: { uploadsFrom: string; workspace?: string };
} & (
  | { web?: null }
  | {
      web: WebSnapshot;
      fetchDeadlineMs: number;
      fetchBodyBytes: number;
      // the send's credentials, their keys read for this command
      credentials?: CommandCredential[];
    }
);
// what a command reads and writes of the docs and uploads, bound to
// knowledge's stores
export type DocsPort = {
  mountedDocs(projectId: string): MountedDoc[];
  mountedUploads(sessionId: string): MountedUploads;
  // the totals alone, read before a mount
  docBytes(projectId: string): number;
  uploadBytes(sessionId: string): number;
  commitDocs: CommitDocs;
};

export type Mount = {
  job: Job;
  rows: MountedDoc[];
  scratch: Scratch;
  // scratch rows whose name the rule no longer allows, dropped on commit
  skipped: string[];
  kept: KeptEntry[];
  storage: KnowledgeCaps;
  // the repository notice and the scratch left out
  left: string;
  mounted: Mounted;
};

export function mountJob(
  deps: {
    db: Db;
    knowledge: DocsPort;
    scratch: ScratchStore;
    current(): KnowledgeCaps;
  },
  caps: CommandCaps,
  command: string,
  started: number,
  projectId: string,
  workspace: Workspace,
  // the shell keeps /tmp itself: no scratch file is read
  ownTmp = false,
): Mount {
  const sessionId = workspaceSession(workspace);
  const repos = caps.repos;
  const storage = deps.current();
  const docs = caps.knowledge;
  const rows = docs ? deps.knowledge.mountedDocs(projectId) : [];
  const stored = ownTmp
    ? { ...deps.scratch.head(workspace), entries: [] }
    : deps.scratch.read(workspace);
  // the worker writes each row at /tmp/<path>, so a row outside the
  // rule never mounts; the commit drops it
  const mountable = mountableScratch(stored.entries);
  const scratch = { ...stored, entries: mountable.kept };
  const skipped = mountable.skipped;
  const left =
    (repos?.notice ?? "") +
    (skipped.length === 0
      ? ""
      : `left out ${skipped.length} file${skipped.length === 1 ? "" : "s"} in /tmp whose name is no longer allowed, dropped when the command saves\n`);
  const usedAt = deps.scratch.usedAt(workspace);
  const scratchTime = usedAt ?? 0;
  const uploadsFrom = caps.subagent?.uploadsFrom ?? sessionId;
  const uploads = deps.knowledge.mountedUploads(uploadsFrom);
  const kept = listKept(deps.db, workspace);
  const keptBytes = kept.reduce((bytes, entry) => bytes + entry.bytes, 0);
  // A lowered cap still permits deleting or shrinking the mounted base.
  const projectBytes = Math.max(
    storage.knowledgeProjectBytes,
    rows.reduce((bytes, row) => bytes + row.bytes, 0),
  );
  const mountBytes =
    projectBytes +
    Math.max(storage.scratchBytes, scratch.bytes) +
    Math.max(storage.uploadBytes, uploads.bytes) +
    // lazy files count when a command reads them
    keptBytes +
    2 * 1024 * 1024;
  const ioBytes = Math.max(
    4 * caps.resultCut,
    storage.scratchBytes,
    storage.knowledgeFileBytes,
    ...uploads.entries.map((file) => file.bytes),
    // the reads the path line teaches (yq, then rg, then sed) add up
    ...kept.map((entry) => 4 * entry.bytes),
  );
  const job: Job = {
    command,
    endsAt: started + caps.callTimeoutMs,
    docs,
    visuals: caps.visuals,
    network: Boolean(caps.web),
    cwd: scratch.cwd,
    knowledgeFileBytes: storage.knowledgeFileBytes,
    mountBytes,
    ioBytes,
    resultCut: caps.resultCut,
    iterations: COMMAND_ITERATIONS,
    knowledge: rows.map((row) => ({
      name: row.name,
      data: row.data,
      mtime: row.updatedAt,
    })),
    // the scratch commit reads only the revision and totals, so its
    // bytes can go
    scratch: scratch.entries.map((file) => ({
      name: file.path,
      data: file.data,
      mode: file.mode,
      mtime: scratchTime,
    })),
    uploads: uploads.entries.map((file) => ({
      name: file.name,
      data: file.data,
      mtime: file.createdAt,
    })),
    kept: kept.map((entry) => entry.path),
    repos: (repos?.mounts ?? []).map((repo) => ({ ...repo })),
    repoFileBytes: repos?.fileBytes ?? 0,
    ...(caps.subagent ? { subagent: true } : {}),
  };
  const mounted: Mounted = {
    docs: rows.map(({ id, name, revision, updatedAt }) => ({
      id,
      name,
      revision,
      updatedAt,
    })),
    scratch: { revision: scratch.revision, usedAt },
    uploads: { sessionId: uploadsFrom, revision: uploads.revision },
    kept: kept.map(({ messageId, position, path, bytes }) => ({
      messageId,
      position,
      path,
      bytes,
    })),
  };
  return { job, rows, scratch, skipped, kept, storage, left, mounted };
}

// the totals of what mountJob would read, from the summary rows alone
export function storedBytes(
  deps: { db: Db; knowledge: DocsPort; scratch: ScratchStore },
  caps: CommandCaps,
  projectId: string,
  workspace: Workspace,
): StoredBytes {
  const uploadsFrom = caps.subagent?.uploadsFrom ?? workspaceSession(workspace);
  return {
    docs: caps.knowledge ? deps.knowledge.docBytes(projectId) : 0,
    uploads: deps.knowledge.uploadBytes(uploadsFrom),
    kept: listKept(deps.db, workspace).reduce((n, entry) => n + entry.bytes, 0),
  };
}
