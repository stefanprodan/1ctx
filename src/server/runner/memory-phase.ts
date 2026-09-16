// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { contextReserve } from "../../shared/compaction.ts";
import type {
  Message,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import { memoryBlock } from "../../shared/memory.ts";
import type { SendCause } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { tokens } from "../lib/tokens.ts";
import type { MemoryCapability } from "../memory/index.ts";
import type {
  ChatMessageIn,
  ChatRequest,
  ToolCall,
} from "../providers/index.ts";
import type { Offered, ToolContext, ToolResult } from "../tools/index.ts";
import { history } from "./context.ts";
import { envelope, lastLine } from "./envelope.ts";
import type { RoundDeps } from "./round.ts";
import { runRound } from "./round.ts";
import { type ActiveSend, newRound } from "./send.ts";
import type { Writer } from "./writer.ts";
import { CUT_SHORT, statusOf } from "./writer.ts";
import type { SessionsPort } from "./writer-port.ts";

export type MemoryCommitDeps = {
  memory: Pick<MemoryCapability, "commit">;
  markers: {
    mark(
      automationId: string,
      marks: readonly { sessionId: string; readActivityAt: number }[],
    ): number;
  };
};

export function commitMemory(
  deps: MemoryCommitDeps,
  send: ActiveSend,
  cause: SendCause,
): number | null {
  let skipped = 0;
  const project = send.policy.offered.memory;
  if (cause === "finish" && project?.note === "project") {
    skipped += deps.memory.commit(project.work, send.sessionId).skipped;
    if (project.read !== null) {
      deps.markers.mark(
        project.read.automationId,
        [...project.read.marks].map(([sessionId, readActivityAt]) => ({
          sessionId,
          readActivityAt,
        })),
      );
    }
  }
  const automation = send.policy.memoryOffered?.memory ?? null;
  if (
    automation?.note === "automation" &&
    automation.work.operations.length > 0
  ) {
    skipped += deps.memory.commit(automation.work, send.sessionId).skipped;
  }
  return skipped === 0 ? null : skipped;
}

type PhaseRowsDeps = {
  db: Db;
  clock: Clock;
  sessions: SessionsPort;
};

function runningSession(
  deps: PhaseRowsDeps,
  send: ActiveSend,
  now: number,
): SessionSummary {
  return deps.sessions.touch(send.sessionId, { status: "running", now })!;
}

export function stopMainTools(deps: PhaseRowsDeps, send: ActiveSend): void {
  if (send.openTools.size === 0) return;
  const now = deps.clock();
  transact(deps.db, () => {
    const rows: Message[] = [];
    for (const rowId of send.openTools.values()) {
      const row = deps.sessions.finishTool(rowId, {
        content: CUT_SHORT,
        status: "stopped",
        error: null,
        finishedAt: now,
      });
      if (row !== null) rows.push(row);
    }
    if (rows.length === 0) return { result: undefined, events: [] };
    return {
      result: undefined,
      events: [envelope(runningSession(deps, send, now), rows, null)],
    };
  });
  send.openTools = new Map();
}

export function startMemory(
  deps: PhaseRowsDeps,
  writer: Writer,
  send: ActiveSend,
): void {
  if (send.cause === null) throw new Error("the run has no ending");
  const now = deps.clock();
  const memoryRound = send.roundNo + 1;
  const started = transact(deps.db, () => {
    const answer = writer.finalizeRound(
      send,
      statusOf(send.cause!),
      send.error,
      now,
    );
    const created = deps.sessions.addReply({
      sessionId: send.sessionId,
      sendId: send.id,
      round: memoryRound,
      agentId: send.policy.agentId,
      model: send.policy.model,
      now,
    });
    const reply = deps.sessions.markSlot(created.id, "work") ?? created;
    const sendRow = deps.sessions.bumpCounters(send.id, {
      memoryRound,
      rounds: memoryRound,
      toolCalls: send.budget.calls,
    })!;
    const session = runningSession(deps, send, now);
    const last =
      answer?.status === "done" && answer.slot === "answer"
        ? lastLine(answer, send.policy.agentName)
        : undefined;
    return {
      result: reply,
      events: [
        envelope(
          session,
          answer ? [answer, reply] : [reply],
          sendRow,
          [],
          last,
        ),
      ],
    };
  });
  send.memoryRound = memoryRound;
  send.roundNo = memoryRound;
  send.phase = "memory";
  send.round = newRound(started.id, started.createdAt);
  send.round.slotMarked = true;
}

function phaseInstruction(send: ActiveSend): string {
  const ending =
    send.cause === "deadline"
      ? "The run was cut by its deadline."
      : send.cause === "failure"
        ? `The run failed${send.error === null ? "." : `: ${send.error}`}`
        : "The run finished.";
  const entries = send.policy.memoryOffered?.memory?.work.entries ?? [];
  const note = memoryBlock("automation-memory", entries);
  const current =
    note === "" ? "The automation memory was empty when this run began." : note;
  return `${ending}\n\n${current}\n\nUpdate this automation's memory with what the next run needs: what was found, what was done, where this run stopped, and what is left.`;
}

function groups(messages: ChatMessageIn[]): {
  head: ChatMessageIn[];
  rounds: ChatMessageIn[][];
} {
  const firstUser = messages.findIndex((message) => message.role === "user");
  if (firstUser < 0) return { head: messages, rounds: [] };
  const head = messages.slice(0, firstUser + 1);
  const rounds: ChatMessageIn[][] = [];
  for (const message of messages.slice(firstUser + 1)) {
    if (message.role === "assistant" || message.role === "user") {
      rounds.push([message]);
    } else if (rounds.length > 0) {
      rounds.at(-1)!.push(message);
    } else {
      head.push(message);
    }
  }
  return { head, rounds };
}

export function memoryRequest(
  send: ActiveSend,
  messages: ChatMessageIn[],
  offered: Offered,
): ChatRequest | null {
  const instruction: ChatMessageIn = {
    role: "user",
    content: phaseInstruction(send),
  };
  const split = groups(messages);
  const rounds = [...split.rounds];
  const build = () => [...split.head, ...rounds.flat(), instruction];
  const window = send.policy.contextLength;
  if (window !== null) {
    const room =
      window - contextReserve(window, send.policy.limits.contextReserve);
    while (tokens(JSON.stringify(build())) > room && rounds.length > 1) {
      rounds.shift();
    }
    if (tokens(JSON.stringify(build())) > room) return null;
  }
  return {
    model: send.policy.model,
    messages: build(),
    thinking: send.policy.thinking,
    reasoningEffort: send.policy.effort,
    cacheKey: send.sessionId,
    ...(offered.tools.length > 0 ? { tools: offered.tools } : {}),
  };
}

function cut(result: ToolResult, chars: number): ToolResult {
  return result.content.length <= chars
    ? result
    : { ...result, content: result.content.slice(0, chars) };
}

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

async function runCalls(
  deps: MemoryPhaseDeps,
  send: ActiveSend,
  offered: Offered,
  calls: ToolCall[],
  signal: AbortSignal,
): Promise<void> {
  const startedAt = deps.clock();
  let writeError: unknown = null;
  const settled = calls.map(async (call) => {
    const ctx: ToolContext = {
      signal,
      now: deps.clock,
      budget: send.toolBudget,
      caps: send.policy.toolCaps,
    };
    let result: ToolResult;
    try {
      result = await deps.tools.run(offered, call, ctx);
    } catch (error) {
      result = {
        content: error instanceof Error ? error.message : String(error),
        error: true,
      };
    }
    if (signal.aborted) return;
    const stored = cut(result, send.policy.toolCaps.resultCut);
    send.budget.resultBytes += bytes(stored.content);
    try {
      deps.writer.finishTool(send, call, stored);
    } catch (error) {
      writeError ??= error;
    }
  });
  const task = Promise.allSettled(settled).then(() => {});
  send.tools = task;
  await task;
  send.tools = null;
  send.budget.toolMs += deps.clock() - startedAt;
  if (writeError !== null) throw writeError;
}

export type MemoryPhaseDeps = PhaseRowsDeps & {
  round: RoundDeps;
  writer: Writer;
  tools: {
    run(
      offered: Offered,
      call: ToolCall,
      ctx: ToolContext,
    ): Promise<ToolResult>;
    toolName?(offered: Offered, call: ToolCall): string;
  };
  historyOf(send: ActiveSend): Message[];
  pause(ms: number): Promise<void>;
};

export async function memoryPhase(
  deps: MemoryPhaseDeps,
  send: ActiveSend,
): Promise<void> {
  const offered = send.policy.memoryOffered;
  if (
    offered?.memory === null ||
    offered === null ||
    send.ending.signal.aborted
  ) {
    return;
  }
  startMemory(deps, deps.writer, send);
  const controller = new AbortController();
  send.controller = controller;
  const stop = () => {
    send.memoryStopped = true;
    controller.abort();
  };
  send.ending.signal.addEventListener("abort", stop, { once: true });
  if (send.ending.signal.aborted) stop();
  let done = false;
  void deps.pause(send.policy.limits.memoryPhaseMs).then(() => {
    if (!done) stop();
  });
  let rounds = 1;
  try {
    while (!controller.signal.aborted) {
      const rows = deps.historyOf(send);
      const messages = history(
        rows,
        send.policy,
        deps.round.lookups,
        deps.clock(),
        send.mcpNote,
      );
      const request = memoryRequest(send, messages, offered);
      if (request === null) throw new Error("the memory phase did not fit");
      try {
        await runRound(deps.round, send, rows, {
          request,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        throw error;
      }
      if (controller.signal.aborted) return;
      const round = send.round;
      if (round === null || round.calls.length === 0) return;
      const calls = round.calls;
      if (
        calls.length > send.policy.limits.callsPerRound ||
        rounds >= send.policy.limits.memoryPhaseRounds
      ) {
        deps.writer.recordUnrun(send, "memory_limit", calls);
        send.round = null;
        return;
      }
      const names = calls.map(
        (call) => deps.tools.toolName?.(offered, call) ?? call.name,
      );
      send.budget.calls = deps.writer.finishRound(send, names).toolCalls;
      send.phase = "memory";
      send.round = null;
      await runCalls(deps, send, offered, calls, controller.signal);
      if (controller.signal.aborted) return;
      const reply = deps.writer.startRound(send);
      send.roundNo += 1;
      rounds += 1;
      send.phase = "memory";
      send.round = newRound(reply.id, reply.createdAt);
      send.round.slotMarked = true;
    }
  } finally {
    done = true;
    send.ending.signal.removeEventListener("abort", stop);
  }
}
