// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  Message,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import type { SendCause } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { tokens } from "../lib/tokens.ts";
import type { MemoryCapability } from "../memory/index.ts";
import type { ChatRequest, ToolCall } from "../providers/index.ts";
import type { Offered, ToolContext, ToolResult } from "../tools/index.ts";
import { type ContextLookups, historyMessages } from "./context.ts";
import { envelope, lastLine } from "./envelope.ts";
import { memoryMessages } from "./memory-packet.ts";
import type { RoundDeps } from "./round.ts";
import { runRound } from "./round.ts";
import { type ActiveSend, newRound } from "./send.ts";
import type { Writer } from "./writer.ts";
import { CUT_SHORT, NOT_RUN, statusOf } from "./writer.ts";
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
    const committed = deps.memory.commit(project.work, send.sessionId);
    skipped += committed.skipped;
    const dropped = new Set(committed.skippedOperations);
    if (project.read !== null) {
      deps.markers.mark(
        project.read.automationId,
        [...project.read.marks]
          .filter(([, mark]) => !dropped.has(mark.operation))
          .map(([sessionId, mark]) => ({
            sessionId,
            readActivityAt: mark.readActivityAt,
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

function memoryRequest(
  send: ActiveSend,
  rows: Message[],
  offered: Offered,
  lookups: ContextLookups,
): ChatRequest | null {
  if (
    send.policy.automation === null ||
    send.memoryRound === null ||
    send.cause === null
  ) {
    throw new Error("the memory phase has no run context");
  }
  const messages = memoryMessages(
    {
      automation: send.policy.automation.name,
      sendId: send.id,
      memoryRound: send.memoryRound,
      cause: send.cause,
      error: send.error,
      rows,
      guidance: send.policy.automation?.memoryGuidance ?? "",
      entries: offered.memory?.work.entries ?? [],
    },
    {
      phase: historyMessages(
        rows.filter(
          (row) => row.sendId === send.id && row.round >= send.memoryRound!,
        ),
        send.policy,
        lookups,
      ),
      tools: offered.tools,
      contextLength: send.policy.contextLength,
      reserve: send.policy.limits.contextReserve,
    },
    tokens,
  );
  if (messages === null) return null;
  return {
    model: send.policy.model,
    messages,
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

// what the phase has spent, kept apart from the send's budget: the
// main rounds may have spent theirs, which never cuts the phase
type PhaseSpend = { calls: number; toolMs: number; resultBytes: number };

async function runCalls(
  deps: MemoryPhaseDeps,
  send: ActiveSend,
  offered: Offered,
  calls: ToolCall[],
  signal: AbortSignal,
  spend: PhaseSpend,
): Promise<boolean> {
  const startedAt = deps.clock();
  let writeError: unknown = null;
  let clean = true;
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
    if (result.error || call.name !== "memory_edit") clean = false;
    const stored = cut(result, send.policy.toolCaps.resultCut);
    spend.resultBytes += bytes(stored.content);
    try {
      deps.writer.finishTool(send, call, stored);
    } catch (error) {
      writeError ??= error;
    }
  });
  const task = Promise.allSettled(settled).then(() => {});
  send.tools = task;
  await task;
  offered.memory?.settleRound();
  send.tools = null;
  spend.toolMs += deps.clock() - startedAt;
  if (writeError !== null) throw writeError;
  return clean;
}

// what a call the phase would not run is recorded with
const LAST_ROUND = "not run: the memory phase was on its last round";
const OVER_ROUND = "not run: too many calls in one round";

// the phase runs under the same caps as a send but counts its own
// spend, so main rounds that spent the send's budget never cut it
function overPhaseCap(
  send: ActiveSend,
  spend: PhaseSpend,
  rounds: number,
  calls: ToolCall[],
): string | null {
  const limits = send.policy.limits;
  if (calls.length > limits.callsPerRound) return OVER_ROUND;
  if (rounds >= limits.memoryPhaseRounds) return LAST_ROUND;
  if (
    spend.calls + calls.length > limits.callsPerSend ||
    spend.toolMs >= limits.toolMs ||
    spend.resultBytes >= limits.resultBytes
  ) {
    return NOT_RUN;
  }
  return null;
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
  // the phase counts its own rounds and calls; the send's budget is the
  // run's and never cuts the phase
  const spend: PhaseSpend = { calls: 0, toolMs: 0, resultBytes: 0 };
  let rounds = 1;
  try {
    while (!controller.signal.aborted) {
      const rows = deps.historyOf(send);
      const request = memoryRequest(send, rows, offered, deps.round.lookups);
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
      const stopWords = overPhaseCap(send, spend, rounds, calls);
      if (stopWords !== null) {
        deps.writer.recordUnrun(send, "memory_limit", calls, stopWords);
        send.round = null;
        return;
      }
      const names = calls.map(
        (call) => deps.tools.toolName?.(offered, call) ?? call.name,
      );
      spend.calls += calls.length;
      send.budget.calls = deps.writer.finishRound(send, names).toolCalls;
      send.phase = "memory";
      send.round = null;
      const clean = await runCalls(
        deps,
        send,
        offered,
        calls,
        controller.signal,
        spend,
      );
      // A round whose edits all succeeded is the phase's work done; asking
      // again only invites a model to go back to the run's task.
      if (clean || controller.signal.aborted || offered.memory.stopped) {
        return;
      }
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
