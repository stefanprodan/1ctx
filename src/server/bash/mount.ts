// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A disposable mount: no transaction is held while the shell runs.

import type { KnowledgeAuthor } from "../../shared/contracts/knowledge.ts";
import type { Db } from "../db/index.ts";
import {
  acquireProcess,
  type Change,
  DocConflict,
} from "../knowledge/index.ts";
import type { Clock } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import { BACKSTOP_MS } from "./commands.ts";
import { checked, commit } from "./commit.ts";
import { commandFetch, scrubKeys } from "./credentials.ts";
import {
  type CommandCaps,
  type DocsPort,
  mountJob,
  storedBytes,
} from "./job.ts";
import { readKept } from "./kept.ts";
import { checkOpened, type OpenedRecord, openedReceipt } from "./open.ts";
import { failed, refused } from "./output.ts";
import type {
  Answer,
  CommandCause,
  CommandEnd,
  CommandPhase,
} from "./protocol.ts";
import { acquireSession } from "./queue.ts";
import { READ_ONLY_TO_SUBAGENT } from "./readback.ts";
import type { ScratchStore } from "./scratch.ts";
import type {
  SettleOutcome,
  ShellBackend,
  ShellCall,
  ShellHold,
  ShellRun,
} from "./shell.ts";
import { type Workspace, workspaceSession } from "./workspace.ts";

export type { CommandCaps, CommandRepos, DocsPort } from "./job.ts";

export type CommandResult = {
  content: string;
  error: boolean;
  tail?: number;
  opened?: OpenedRecord[];
  // the /knowledge paths the command wrote, stored on its tool row
  saved?: string[];
  // where a command that saved nothing ended, for the log; finishTool
  // stores a row's fields by name, so it never reaches one
  ended?: CommandEnd;
  // the caller's abort ended it, so this is no result: the runner writes
  // its cut text instead. Never stored
  interrupted?: boolean;
  // with interrupted: it stopped before the commit, so neither tree was
  // written
  discarded?: boolean;
};
type MountDeps = {
  db: Db;
  knowledge: DocsPort;
  scratch: ScratchStore;
  clock: Clock;
  log: Log;
  // the shell of this command, asked once per command
  shell(): ShellBackend;
  current(): KnowledgeCaps;
  // each phase a command's worker reports, by chat
  onPhase?(sessionId: string, phase: "run" | "diff"): void;
  // BACKSTOP_MS unless a test needs the deadline alone to decide
  backstopMs?: number;
  // a process slot, acquireProcess unless a test watches the waits
  acquire?(signal: AbortSignal): Promise<() => void>;
};

const seconds = (ms: number) => Math.round(ms / 1000);
// less left than this after the queues and the command is not started:
// a worker barely loads in it
const MIN_RUN_MS = 100;
// the call's deadline passed in a queue; neither words invite a retry at
// once, which would rejoin the queue at its back
function busy(waitedMs: number, timeoutMs: number, longest: Wait) {
  return longest === "own"
    ? `command not run: this chat's earlier commands used the ${seconds(timeoutMs)} s call timeout, combine steps into fewer commands`
    : `command not run: waited ${seconds(waitedMs)} s for a free ${longest}, the server is busy`;
}

// what a command waited for longest: the chat's own earlier commands,
// a shell, or a process slot
type Wait = "own" | "shell" | "slot";

function scrubbedAnswer(
  answer: Answer,
  credentials: ShellCall["credentials"],
): Answer {
  if (!credentials.some((credential) => "key" in credential)) return answer;
  return {
    ...answer,
    stdout: scrubKeys(answer.stdout, credentials),
    stderr: scrubKeys(answer.stderr, credentials),
  };
}

export const SHELL_SWITCHED =
  "the shell changed during this turn, so the command did not run: finish with what you have";

// 124 is the interpreter's own deadline, 126 another of its limits,
// unless the shell's exits are the command's own: the stop decides,
// whatever changes came with it
function stopOf(
  shell: ShellBackend,
  answer: Answer,
): "deadline" | "limit" | undefined {
  if (shell.ownExits) return answer.stopped;
  if (answer.exitCode === 124) return "deadline";
  return answer.exitCode === 126 ? "limit" : undefined;
}

function stopped(
  answer: Answer,
  stop: "deadline" | "limit",
  late: string,
  notice: string,
  resultCut: number,
): CommandResult {
  const head = stop === "deadline" ? late + notice : notice;
  const printed = refused(
    answer.stdout,
    answer.stderr,
    answer.exitCode,
    "command stopped at a deadline or limit",
    resultCut - head.length,
  );
  return {
    ...printed,
    content: head + printed.content,
    error: true,
    ended: {
      phase: "run",
      cause: stop,
    },
  };
}

export async function run(
  deps: MountDeps,
  projectId: string,
  workspace: Workspace,
  author: KnowledgeAuthor,
  command: string,
  given: CommandCaps,
  signal: AbortSignal,
  sendId: string,
): Promise<CommandResult> {
  const sessionId = workspaceSession(workspace);
  // the deadline is wall time, which a worker's thread and the timer
  // keep; the waits a result names are the clock's, so a test moves them
  const started = Date.now();
  const began = deps.clock();
  const slotOf = deps.acquire ?? acquireProcess;
  // the shell is picked once, before the timers its deadline sets
  const shell = deps.shell();
  // a subagent's credentials were offered for the shell of its send's
  // start (tools/offer.ts): another one runs none of its commands
  if (
    given.subagent &&
    (given.sandboxCommandMs !== undefined) !==
      (shell.sharedWithSubagents === true)
  )
    return {
      ...failed(new Error(SHELL_SWITCHED), given.resultCut),
      ended: { phase: "queue", cause: "error" },
    };
  const ownTmp = shell.ownTmp === true;
  const caps: CommandCaps =
    shell.sandboxTimeout && given.sandboxCommandMs !== undefined
      ? { ...given, callTimeoutMs: given.sandboxCommandMs }
      : given;
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error("command timed out")),
    caps.callTimeoutMs + (deps.backstopMs ?? BACKSTOP_MS),
  );
  const combined = AbortSignal.any([signal, deadline.signal]);
  let release: (() => void) | undefined;
  let releaseSession: (() => void) | undefined;
  // what the shell's acquire took, until the run takes it over
  let hold: ShellHold | null = null;
  // the run whose settle is owed, given once
  let ran: ShellRun | null = null;
  const settle = (outcome: SettleOutcome): string | undefined => {
    const owed = ran;
    ran = null;
    if (owed === null) return;
    try {
      return owed.settle(outcome);
    } catch (error) {
      deps.log.warn("shell settle failed", {
        chat: sessionId,
        ...errorFields(error),
      });
    }
  };
  // set once the answer is checked for its commit: a throw from there
  // is the commit's
  let committing = false;
  // a repository's notice stands even when the command never mounts
  let notice = caps.repos?.notice ?? "";
  // set once the command ran, so a refused save still shows its output
  let answer: Answer | undefined;
  let phase: CommandPhase = "queue";
  // true while the shell's acquire is pending
  let inShell = false;
  // the worker's word when neither signal fired: a shutdown is an abort
  let ended: CommandCause = "error";
  // a late start leads the result, so the command never reads as too slow
  let late = "";
  // when the chat's turn came and when its shell was held, to name the
  // longest wait
  let turnAt: number | undefined;
  let heldAt: number | undefined;
  const longest = (now: number): Wait => {
    const turn = turnAt ?? now;
    const held = heldAt ?? now;
    const queued = turn - began;
    const shellWait = held - turn;
    // a shell that was not free names itself unless the chat's own
    // commands took longer
    if (inShell) return queued > shellWait ? "own" : "shell";
    const slotWait = now - held;
    if (queued >= shellWait && queued >= slotWait) return "own";
    return shellWait > slotWait ? "shell" : "slot";
  };
  const busyResult = (): CommandResult => {
    const now = deps.clock();
    return {
      content: notice + busy(now - began, caps.callTimeoutMs, longest(now)),
      error: true,
      ended: { phase: "queue", cause: "busy" },
    };
  };
  const cause = (): CommandCause => {
    const reason = signal.reason;
    // the tool's own timer ends the call as the deadline does
    const timedOut =
      deadline.signal.aborted ||
      (signal.aborted &&
        reason instanceof DOMException &&
        reason.name === "TimeoutError");
    if (timedOut) return phase === "queue" ? "busy" : "deadline";
    return signal.aborted ? "abort" : ended;
  };
  const call: ShellCall = {
    projectId,
    workspace,
    root:
      shell.sharedWithSubagents && caps.subagent?.workspace !== undefined
        ? caps.subagent.workspace
        : workspace.id,
    sendId,
    subagent: Boolean(caps.subagent),
    repos: (caps.repos?.mounts ?? []).map((repo) => ({
      name: repo.name,
      tree: repo.folder,
    })),
    repoFileBytes: caps.repos?.fileBytes ?? 0,
    network: Boolean(caps.web),
    credentials: caps.web ? (caps.credentials ?? []) : [],
    stored: () => storedBytes(deps, caps, projectId, workspace),
  };
  try {
    releaseSession = await acquireSession(
      workspace,
      combined,
      shell.atOnce === true,
    );
    turnAt = deps.clock();
    if (shell.acquire) {
      inShell = true;
      const got = await shell.acquire(
        call,
        started + caps.callTimeoutMs,
        combined,
      );
      if (got === "busy") return busyResult();
      hold = got;
      inShell = false;
    }
    // without an acquire no time goes to the shell
    heldAt = shell.acquire ? deps.clock() : turnAt;
    release = await slotOf(combined);
    combined.throwIfAborted();
    const now = deps.clock();
    const waitedMs = now - began;
    // the slots came with the call's time spent: running would only end
    // at once at the deadline, which is the wall's
    if (started + caps.callTimeoutMs - Date.now() < MIN_RUN_MS)
      return busyResult();
    if (waitedMs > 1000) {
      const wait = longest(now);
      const behind =
        wait === "own"
          ? "behind this chat's earlier commands"
          : `for a free ${wait}`;
      late = `waited ${seconds(waitedMs)} s ${behind}, so the command had ${Math.max(0, seconds(caps.callTimeoutMs) - seconds(waitedMs))} s to run\n`;
    }
    phase = "mount";
    const { job, rows, scratch, skipped, kept, storage, left, mounted } =
      mountJob(deps, caps, command, started, projectId, workspace, ownTmp);
    const docs = caps.knowledge;
    notice = left;
    // the hold is the backend's from here, whatever run does
    const handed = hold;
    hold = null;
    ran = await shell.run(
      job,
      {
        ...call,
        mounted,
        hold: handed,
        docs: () => (docs ? deps.knowledge.mountedDocs(projectId) : []),
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
        slot: {
          free() {
            const held = release;
            release = undefined;
            held?.();
          },
          async take(waiting) {
            if (release === undefined) release = await slotOf(waiting);
          },
        },
      },
      {
        signal,
        deadline: deadline.signal,
        chat: sessionId,
        phase: (reached) => deps.onPhase?.(sessionId, reached),
      },
    );
    const settled = ran.settled;
    if (!settled.ok) {
      phase = settled.phase;
      notice = left + settled.notice;
      ended = settled.cause;
      throw combined.aborted ? combined.reason : settled.error;
    }
    // a key crossing the cut would leave a fragment no scrub matches,
    // so the output is scrubbed whole before any cut
    answer = scrubbedAnswer(settled.answer, call.credentials);
    phase = "diff";
    notice = left + answer.notice;
    combined.throwIfAborted();
    const stop = stopOf(shell, answer);
    if (stop !== undefined) {
      return stopped(answer, stop, late, notice, caps.resultCut);
    }
    if (answer.refused !== null) throw new Error(answer.refused);
    committing = true;
    // a shell that read the rows again at its save diffs against those
    const against = ran.rows ?? rows;
    const before = new Map(
      against.map(({ data: _, ...row }) => [row.name, row]),
    );
    const answered = checked(
      answer.changes,
      before,
      scratch,
      docs,
      storage.scratchFiles,
    );
    // a shell that keeps /tmp itself answers no scratch file
    if (
      ownTmp &&
      (answered.written.length > 0 || answered.removed.length > 0)
    ) {
      throw new Error("the command worker answered out of protocol");
    }
    // the worker's own refusal is only words; the server's is this
    if (
      caps.subagent &&
      !shell.sharedWithSubagents &&
      answered.knowledge.length > 0
    ) {
      throw new Error(READ_ONLY_TO_SUBAGENT);
    }
    const opened = checkOpened(answer.opened, {
      knowledgeFileBytes: storage.knowledgeFileBytes,
      visuals: caps.visuals,
      knowledge: docs,
      open: !caps.subagent,
    });
    const changes: Change[] = answered.knowledge.map((change) => ({
      name: change.name,
      before: before.get(change.name) ?? null,
      text: change.text,
    }));
    phase = "commit";
    combined.throwIfAborted();
    const { printed, landed } = commit(
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
        workspace,
        before: scratch,
        owned: ownTmp,
        changes: {
          written: answered.written,
          removed: [...answered.removed, ...skipped],
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
    settle({ landed: true, ...landed });
    return {
      ...printed,
      content: notice + printed.content,
      error: answer.exitCode !== 0,
      opened,
    };
  } catch (error) {
    const words = settle(
      !committing
        ? { landed: false, why: "skipped" }
        : error instanceof DocConflict
          ? { landed: false, why: "thrown", moved: error.doc }
          : { landed: false, why: "thrown" },
    );
    const why = cause();
    if (why === "busy") return busyResult();
    if (why === "deadline") notice = late + notice;
    const cut = caps.resultCut - notice.length;
    const shown = words === undefined ? error : new Error(words);
    const result = answer
      ? refused(answer.stdout, answer.stderr, answer.exitCode, shown, cut)
      : failed(shown, cut);
    return {
      ...result,
      content: notice + result.content,
      ended: { phase, cause: why },
      // a throw at any phase, the commit's included, wrote nothing
      ...(why === "abort" ? { interrupted: true, discarded: true } : {}),
    };
  } finally {
    clearTimeout(timer);
    // a run that saved nothing and returned, an exit at a limit
    settle({ landed: false, why: "skipped" });
    hold?.release();
    release?.();
    releaseSession?.();
  }
}
