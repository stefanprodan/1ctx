// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The bash command: a chat's commands over the project docs, its scratch,
// its uploads and its kept MCP files. The docs and uploads stay
// knowledge's and reach a command through its port; a command's writes
// to both land in one transaction.

import type { KnowledgeAuthor } from "../../shared/contracts/knowledge.ts";
import type { SandboxVariant } from "../../shared/contracts/sandbox.ts";
import type { SandboxNet } from "../../shared/sandbox-net.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { Log } from "../lib/log.ts";
import type { KnowledgeCaps, SandboxCaps } from "../limits/index.ts";
import {
  copyBack,
  copyIn,
  type Returned,
  type ScratchBaseline,
} from "./handoff.ts";
import { startKept } from "./kept.ts";
import {
  type CommandCaps,
  type CommandResult,
  type DocsPort,
  run,
} from "./mount.ts";
import { ScratchStore } from "./scratch.ts";
import { builtinShell, type ShellBackend } from "./shell.ts";
import { commandWorkers } from "./worker.ts";
import type { Workspace } from "./workspace.ts";

export type BashDeps = {
  db: Db;
  clock: Clock;
  limits: {
    current(): KnowledgeCaps &
      Pick<SandboxCaps, "sandboxCommandSeconds" | "sandboxIdleMinutes">;
  };
  log: Log;
  // the command worker entry, built where the binary resolves it
  worker: URL;
  // the shell of a project's next command, asked once per command so a
  // setting can switch it between commands; without it every command
  // runs in the builtin one, just-bash in that worker
  shell?(builtin: ShellBackend, projectId: string | null): ShellBackend;
  // the sandbox shell's network setting; off without it
  sandboxNet?(): SandboxNet;
  // the variant a project's sandbox runs, null for a custom image;
  // python without it
  sandboxVariant?(projectId: string | null): SandboxVariant | null;
  // each phase a command's worker reports, by chat; a test waits on it
  onCommandPhase?(sessionId: string, phase: "run" | "diff"): void;
  // a process slot, acquireProcess unless a test watches the waits
  acquireProcess?(signal: AbortSignal): Promise<() => void>;
  // BACKSTOP_MS unless a test needs the deadline alone to decide
  backstopMs?: number;
  knowledge: DocsPort;
};
export type BashCapability = {
  // the network of the sandbox shell a project's next command runs in,
  // so the tool's description says what differs; null under just-bash.
  // Without a project, the instance's shell
  sandbox?(projectId?: string | null): SandboxNet | null;
  // the image variant of that sandbox, so the description names its
  // tools; null for a custom image
  sandboxVariant?(projectId?: string | null): SandboxVariant | null;
  // how long a command may run under the sandbox shell, and an unused
  // sandbox is kept
  sandboxCommandSeconds?(): number;
  sandboxIdleMinutes?(): number;
  run(
    projectId: string,
    workspace: Workspace,
    author: KnowledgeAuthor,
    command: string,
    caps: CommandCaps,
    signal: AbortSignal,
    // the send the command is a call of, which a shell may key on
    sendId: string,
  ): Promise<CommandResult>;
  // a send's start: the session's kept MCP files trimmed to the budget,
  // and the number the next kept folder takes; files of rows past
  // afterSeq, which a regenerate deletes, are not counted
  startKept(
    workspace: Workspace,
    afterSeq: number | null,
  ): {
    next: number;
    used: number;
    files: number;
    maxBytes: number;
    maxFiles: number;
  };
  // a subagent's /tmp (bash/handoff.ts): its parent's files copied in
  // at its start, and what it added or changed copied back at its end
  // to a folder none of taken nor the parent's files hold
  copyScratch(from: Workspace, to: Workspace): ScratchBaseline;
  returnScratch(
    child: Workspace,
    parent: Workspace,
    taken: Set<string>,
    baseline: ScratchBaseline,
  ): Promise<Returned>;
  // a child's scratch, when its files could not come back
  dropScratch(workspace: Workspace): void;
};
// what the bash tool reads of the area: a command, and the sandbox
// shell's words
export type BashToolPort = Pick<
  BashCapability,
  | "run"
  | "sandbox"
  | "sandboxVariant"
  | "sandboxCommandSeconds"
  | "sandboxIdleMinutes"
>;
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
  const builtin = builtinShell(workers);
  const pick = deps.shell;
  return {
    scratch,
    sandbox: (projectId) =>
      pick !== undefined && pick(builtin, projectId ?? null) !== builtin
        ? (deps.sandboxNet?.() ?? { mode: "off", hosts: [] })
        : null,
    sandboxVariant: (projectId) =>
      deps.sandboxVariant ? deps.sandboxVariant(projectId ?? null) : "python",
    sandboxCommandSeconds: () => deps.limits.current().sandboxCommandSeconds,
    sandboxIdleMinutes: () => deps.limits.current().sandboxIdleMinutes,
    run: (projectId, workspace, author, command, caps, signal, sendId) =>
      run(
        {
          db: deps.db,
          knowledge: deps.knowledge,
          scratch,
          clock: deps.clock,
          log: deps.log,
          shell: pick ? (id) => pick(builtin, id) : () => builtin,
          current: () => deps.limits.current(),
          ...(deps.onCommandPhase ? { onPhase: deps.onCommandPhase } : {}),
          ...(deps.backstopMs ? { backstopMs: deps.backstopMs } : {}),
          ...(deps.acquireProcess ? { acquire: deps.acquireProcess } : {}),
        },
        projectId,
        workspace,
        author,
        command,
        caps,
        signal,
        sendId,
      ),
    startKept: (workspace, afterSeq) =>
      transact(deps.db, () => {
        const caps = deps.limits.current();
        return {
          result: {
            ...startKept(deps.db, workspace, caps, afterSeq),
            maxBytes: caps.mcpKeptBytes,
            maxFiles: caps.mcpKeptFiles,
          },
          events: [],
        };
      }),
    copyScratch: (from, to) => copyIn(deps.db, scratch, from, to, deps.clock()),
    returnScratch: (child, parent, taken, baseline) =>
      copyBack(
        { db: deps.db, store: scratch, current: () => deps.limits.current() },
        child,
        parent,
        taken,
        baseline,
        deps.clock(),
      ),
    dropScratch: (workspace) => scratch.dropWorkspace(workspace),
    sweep: (now) => scratch.sweep(now, deps.limits.current().scratchIdleDays),
    close: () => workers.close(),
  };
}

export {
  BACKSTOP_MS,
  MAX_COMMAND_BYTES,
  MAX_OPENS_PER_COMMAND,
} from "./commands.ts";
export {
  type CommandCredential,
  escapedForms,
  REFUSALS,
  type Refusal,
  scrubBytes,
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
export { type OpenedRecord, openedRecord } from "./open.ts";
export {
  mountPath,
  normalizePath,
  prefixes,
  underKnowledge,
  underRoot,
} from "./paths.ts";
export type {
  Answer,
  Changes,
  CommandEnd,
  Job,
  JobRepo,
} from "./protocol.ts";
export {
  discardNotices,
  type EntryKind,
  exitAt,
  READ_ONLY_TO_SUBAGENT,
  type ReadBack,
  readBack,
  savedCwd,
  sharedChange,
  startNotice,
  type TreeEntry,
  type TreeMount,
  treeChanges,
} from "./readback.ts";
export type {
  Mounted,
  SettleOutcome,
  ShellBackend,
  ShellCall,
  ShellContext,
  ShellHold,
  ShellRepo,
  ShellRun,
  StoredBytes,
} from "./shell.ts";
export type {
  CommandHooks,
  CommandStops,
  Settled,
} from "./worker.ts";
export {
  sessionWorkspace,
  type Workspace,
  workspaceOf,
} from "./workspace.ts";
