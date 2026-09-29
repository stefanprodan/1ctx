// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A disposable mount keeps shared text and session scratch atomic without
// holding a database transaction while the shell runs. The server's
// thread admits the command, reads the rows and commits; the shell runs
// in a worker, so a command that never yields holds no stream.

import type { KnowledgeAuthor } from "../../shared/contracts/knowledge.ts";
import type { WebSnapshot } from "../../shared/web.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import { COMMAND_ITERATIONS } from "./commands.ts";
import { type Change, commit } from "./commit.ts";
import { type CommandCredential, commandFetch } from "./credentials.ts";
import { listKept, readKept } from "./kept.ts";
import { type OpenedRecord, openedReceipt } from "./open.ts";
import { failed, output } from "./output.ts";
import type { CommandCause, CommandEnd, CommandPhase } from "./protocol.ts";
import { acquire, acquireSession } from "./queue.ts";
import type { ScratchStore } from "./scratch.ts";
import type { KnowledgeStore } from "./store.ts";
import type { UploadStore } from "./uploads.ts";
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
  // where a command that saved nothing ended, for the log; unlisted, so
  // it never reaches a stored row
  ended?: CommandEnd;
};
type MountDeps = {
  db: Db;
  store: KnowledgeStore;
  scratch: ScratchStore;
  uploads: UploadStore;
  clock: Clock;
  workers: CommandWorkers;
  current(): KnowledgeCaps;
};

function ended<T extends object>(result: T, end: CommandEnd): T {
  Object.defineProperty(result, "ended", { value: end });
  return result;
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
  const cause = (): CommandCause => {
    if (deadline.signal.aborted) return "deadline";
    if (!signal.aborted) return "error";
    // the tool's own timer ends the call as the deadline does
    const reason = signal.reason;
    return reason instanceof DOMException && reason.name === "TimeoutError"
      ? "deadline"
      : "abort";
  };
  try {
    releaseSession = await acquireSession(sessionId, combined);
    release = await acquire(combined);
    combined.throwIfAborted();
    phase = "mount";
    const storage = deps.current();
    const docs = caps.knowledge;
    const rows = docs ? deps.store.mounted(projectId) : [];
    const scratch = deps.scratch.read(sessionId);
    const scratchTime = deps.scratch.usedAt(sessionId) ?? 0;
    const uploads = deps.uploads.mounted(sessionId);
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
      { signal, deadline: deadline.signal, chat: sessionId },
    );
    if (!settled.ok) {
      phase = settled.phase;
      notice = settled.notice;
      throw combined.aborted ? combined.reason : settled.error;
    }
    const answer = settled.answer;
    phase = "diff";
    notice = answer.notice;
    combined.throwIfAborted();
    if (answer.changes === null) {
      const printed = output(
        answer.stdout,
        `${answer.stderr}\nnothing saved: command stopped at a deadline or limit`,
        answer.exitCode,
        [],
        caps.resultCut - notice.length,
      );
      return ended(
        { ...printed, content: notice + printed.content, error: true },
        { phase: "run", cause: "limit" },
      );
    }
    const mounted = new Map(rows.map(({ data: _, ...row }) => [row.name, row]));
    const changes: Change[] = answer.changes.knowledge.map((change) => ({
      name: change.name,
      before: mounted.get(change.name) ?? null,
      text: change.text,
    }));
    phase = "commit";
    combined.throwIfAborted();
    const printed = commit(
      deps,
      projectId,
      author,
      changes,
      {
        sessionId,
        before: scratch,
        changes: {
          written: answer.changes.written,
          removed: answer.changes.removed,
          cwd: answer.changes.cwd,
        },
        totals: answer.changes.totals,
      },
      {
        stdout: answer.stdout,
        stderr: answer.stderr,
        exitCode: answer.exitCode,
      },
      answer.opened.map(openedReceipt),
      caps.resultCut - notice.length,
      combined,
      deps.clock(),
    );
    return {
      ...printed,
      content: notice + printed.content,
      error: answer.exitCode !== 0,
      opened: answer.opened,
    };
  } catch (error) {
    const result = failed(error, caps.resultCut - notice.length);
    return ended(
      { ...result, content: notice + result.content },
      { phase, cause: cause() },
    );
  } finally {
    clearTimeout(timer);
    release?.();
    releaseSession?.();
  }
}
