// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The bash command: a chat's commands over the project docs, its scratch,
// its uploads and its kept MCP files. The docs and uploads stay
// knowledge's and reach a command through its port; a command's writes
// to both land in one transaction.

import type { KnowledgeAuthor } from "../../shared/contracts/knowledge.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { Log } from "../lib/log.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import {
  copyBack,
  copyIn,
  type Returned,
  type ScratchBaseline,
  scratchFolder,
} from "./handoff.ts";
import { startKept } from "./kept.ts";
import {
  type CommandCaps,
  type CommandResult,
  type DocsPort,
  run,
} from "./mount.ts";
import { ScratchStore } from "./scratch.ts";
import { commandWorkers } from "./worker.ts";

export type BashDeps = {
  db: Db;
  clock: Clock;
  limits: { current(): KnowledgeCaps };
  log: Log;
  // the command worker entry, built where the binary resolves it
  worker: URL;
  // each phase a command's worker reports, by chat; a test waits on it
  onCommandPhase?(sessionId: string, phase: "run" | "diff"): void;
  knowledge: DocsPort;
};
export type BashCapability = {
  run(
    projectId: string,
    sessionId: string,
    author: KnowledgeAuthor,
    command: string,
    caps: CommandCaps,
    signal: AbortSignal,
  ): Promise<CommandResult>;
  // a send's start: the session's kept MCP files trimmed to the budget,
  // and the number the next kept folder takes; files of rows past
  // afterSeq, which a regenerate deletes, are not counted
  startKept(
    sessionId: string,
    afterSeq: number | null,
  ): {
    next: number;
    used: number;
    files: number;
    maxBytes: number;
    maxFiles: number;
  };
  // a subagent's /tmp (bash/handoff.ts): the folder its files come back
  // to, its parent's files copied in at its start, and what it added
  // or changed copied back at its end
  scratchFolder(sessionId: string, taken: ReadonlySet<string>): string;
  copyScratch(from: string, to: string): ScratchBaseline;
  returnScratch(
    child: string,
    parent: string,
    folder: string,
    baseline: ScratchBaseline,
  ): Promise<Returned>;
};
export type BashArea = BashCapability & {
  scratch: ScratchStore;
  // idle scratch no command holds
  sweep(now: number): number;
  // shutdown: the workers of running commands ended
  close(): void;
};

export function bashArea(deps: BashDeps): BashArea {
  const scratch = new ScratchStore(deps.db);
  const workers = commandWorkers(deps.worker, deps.log);
  return {
    scratch,
    run: (projectId, sessionId, author, command, caps, signal) =>
      run(
        {
          db: deps.db,
          knowledge: deps.knowledge,
          scratch,
          clock: deps.clock,
          workers,
          current: () => deps.limits.current(),
          ...(deps.onCommandPhase ? { onPhase: deps.onCommandPhase } : {}),
        },
        projectId,
        sessionId,
        author,
        command,
        caps,
        signal,
      ),
    startKept: (sessionId, afterSeq) =>
      transact(deps.db, () => {
        const caps = deps.limits.current();
        return {
          result: {
            ...startKept(deps.db, sessionId, caps, afterSeq),
            maxBytes: caps.mcpKeptBytes,
            maxFiles: caps.mcpKeptFiles,
          },
          events: [],
        };
      }),
    scratchFolder: (sessionId, taken) =>
      scratchFolder(scratch, sessionId, taken),
    copyScratch: (from, to) => copyIn(deps.db, scratch, from, to, deps.clock()),
    returnScratch: (child, parent, folder, baseline) =>
      copyBack(
        { db: deps.db, store: scratch, current: () => deps.limits.current() },
        child,
        parent,
        folder,
        baseline,
        deps.clock(),
      ),
    sweep: (now) => scratch.sweep(now, deps.limits.current().scratchIdleDays),
    close: () => workers.close(),
  };
}

export { BACKSTOP_MS } from "./commands.ts";
export {
  type CommandCredential,
  type Refusal,
  scrubKeys,
} from "./credentials.ts";
export type { Returned, ScratchBaseline } from "./handoff.ts";
export {
  compressKept,
  copyKeptFiles,
  KEPT_PACK_FROM,
  KEPT_PACKED_READ,
  KEPT_UNPACK_ERROR,
  type KeptFile,
  type KeptPending,
  keptPath,
  pendingKept,
  readKeptRaw,
  walkKept,
  writeKeptFiles,
  writeKeptFrame,
} from "./kept.ts";
export type { CommandResult } from "./mount.ts";
export type { OpenedRecord } from "./open.ts";
export type { CommandEnd, JobRepo } from "./protocol.ts";
