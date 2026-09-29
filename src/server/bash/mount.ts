// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A disposable mount keeps shared text and session scratch atomic without
// holding a database transaction while the shell runs. The server's
// thread admits the command, reads the rows and commits; the shell runs
// in a worker, so a command that never yields holds no stream.

import type {
  KnowledgeAuthor,
  KnowledgeFile,
} from "../../shared/contracts/knowledge.ts";
import type { WebSnapshot } from "../../shared/web.ts";
import type { Db } from "../db/index.ts";
import {
  acquireProcess,
  type Change,
  type MountedDoc,
  type MountedUploads,
} from "../knowledge/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import { COMMAND_ITERATIONS } from "./commands.ts";
import { type CommitDocs, commit } from "./commit.ts";
import { type CommandCredential, commandFetch } from "./credentials.ts";
import { listKept, readKept } from "./kept.ts";
import {
  checkOpened,
  mountPath,
  type OpenedRecord,
  openedReceipt,
} from "./open.ts";
import { failed, output } from "./output.ts";
import type {
  Changes,
  CommandCause,
  CommandEnd,
  CommandPhase,
} from "./protocol.ts";
import { acquireSession } from "./queue.ts";
import type { Scratch, ScratchStore } from "./scratch.ts";
import type { CommandWorkers } from "./worker.ts";

export type CommandCaps = {
  callTimeoutMs: number;
  resultCut: number;
  visuals: boolean;
  // false while the send has the project docs off: no /knowledge
  knowledge: boolean;
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
export type CommandResult = {
  content: string;
  error: boolean;
  tail?: number;
  opened?: OpenedRecord[];
  // where a command that saved nothing ended, for the log; finishTool
  // stores a row's fields by name, so it never reaches one
  ended?: CommandEnd;
};
// what a command reads and writes of the docs and uploads, bound to
// knowledge's stores
export type DocsPort = {
  mountedDocs(projectId: string): MountedDoc[];
  mountedUploads(sessionId: string): MountedUploads;
  commitDocs: CommitDocs;
};
type MountDeps = {
  db: Db;
  knowledge: DocsPort;
  scratch: ScratchStore;
  clock: Clock;
  workers: CommandWorkers;
  current(): KnowledgeCaps;
  // each phase a command's worker reports, by chat
  onPhase?(sessionId: string, phase: "run" | "diff"): void;
};

// what the worker answered, held to the mounted trees: no doc changes
// with the docs off, a delete names a mounted doc, no name twice, and
// scratch removes only what it mounted, since a command inside could
// post an answer of its own
function checked(
  changes: Changes | null,
  docs: ReadonlyMap<string, KnowledgeFile>,
  scratch: Scratch,
  knowledge: boolean,
): Changes {
  if (changes === null || (!knowledge && changes.knowledge.length > 0))
    throw new Error("the command worker answered out of protocol");
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
  let phase: CommandPhase = "queue";
  // the worker's word when neither signal fired: a shutdown is an abort
  let ended: CommandCause = "error";
  const cause = (): CommandCause => {
    if (deadline.signal.aborted) return "deadline";
    if (!signal.aborted) return ended;
    // the tool's own timer ends the call as the deadline does
    const reason = signal.reason;
    return reason instanceof DOMException && reason.name === "TimeoutError"
      ? "deadline"
      : "abort";
  };
  try {
    releaseSession = await acquireSession(sessionId, combined);
    release = await acquireProcess(combined);
    combined.throwIfAborted();
    phase = "mount";
    const storage = deps.current();
    const docs = caps.knowledge;
    const rows = docs ? deps.knowledge.mountedDocs(projectId) : [];
    const scratch = deps.scratch.read(sessionId);
    const scratchTime = deps.scratch.usedAt(sessionId) ?? 0;
    const uploads = deps.knowledge.mountedUploads(sessionId);
    const kept = listKept(deps.db, sessionId);
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
    const settled = await deps.workers.run(
      {
        command,
        endsAt: started + caps.callTimeoutMs,
        docs,
        visuals: caps.visuals,
        network: Boolean(caps.web),
        cwd: scratch.cwd,
        knowledgeFileBytes: storage.knowledgeFileBytes,
        mountBytes,
        ioBytes,
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
      },
      {
        // MCP results past the cut, read from the database on first read
        kept: (index) =>
          readKept(deps.db, kept[index]!.messageId, kept[index]!.position),
        fetch: caps.web
          ? commandFetch(caps.web, caps.credentials ?? [], {
              timeoutMs: caps.fetchDeadlineMs,
              maxResponseSize: caps.fetchBodyBytes,
            })
          : null,
      },
      {
        signal,
        deadline: deadline.signal,
        chat: sessionId,
        phase: (reached) => deps.onPhase?.(sessionId, reached),
      },
    );
    if (!settled.ok) {
      phase = settled.phase;
      notice = settled.notice;
      ended = settled.cause;
      throw combined.aborted ? combined.reason : settled.error;
    }
    const answer = settled.answer;
    phase = "diff";
    notice = answer.notice;
    combined.throwIfAborted();
    // the exit decides, whatever changes came with it
    if (answer.exitCode === 124 || answer.exitCode === 126) {
      const printed = output(
        answer.stdout,
        `${answer.stderr}\nnothing saved: command stopped at a deadline or limit`,
        answer.exitCode,
        [],
        caps.resultCut - notice.length,
      );
      return {
        ...printed,
        content: notice + printed.content,
        error: true,
        // 124 is the interpreter's own deadline, 126 another of its limits
        ended: {
          phase: "run",
          cause: answer.exitCode === 124 ? "deadline" : "limit",
        },
      };
    }
    const mounted = new Map(rows.map(({ data: _, ...row }) => [row.name, row]));
    const answered = checked(answer.changes, mounted, scratch, docs);
    const opened = checkOpened(answer.opened, {
      knowledgeFileBytes: storage.knowledgeFileBytes,
      visuals: caps.visuals,
      knowledge: docs,
    });
    const changes: Change[] = answered.knowledge.map((change) => ({
      name: change.name,
      before: mounted.get(change.name) ?? null,
      text: change.text,
    }));
    phase = "commit";
    combined.throwIfAborted();
    const printed = commit(
      {
        db: deps.db,
        scratch: deps.scratch,
        commitDocs: deps.knowledge.commitDocs,
        current: deps.current,
      },
      projectId,
      author,
      changes,
      {
        sessionId,
        before: scratch,
        changes: {
          written: answered.written,
          removed: answered.removed,
          cwd: answered.cwd,
        },
      },
      {
        stdout: answer.stdout,
        stderr: answer.stderr,
        exitCode: answer.exitCode,
      },
      opened.map(openedReceipt),
      caps.resultCut - notice.length,
      combined,
      deps.clock(),
    );
    return {
      ...printed,
      content: notice + printed.content,
      error: answer.exitCode !== 0,
      opened,
    };
  } catch (error) {
    const result = failed(error, caps.resultCut - notice.length);
    return {
      ...result,
      content: notice + result.content,
      ended: { phase, cause: cause() },
    };
  } finally {
    clearTimeout(timer);
    release?.();
    releaseSession?.();
  }
}
