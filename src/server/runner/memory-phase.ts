// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message } from "../../shared/contracts/session.ts";
import { type Db, transact } from "../db/index.ts";
import { after, type Clock } from "../lib/clock.ts";
import type { Log } from "../lib/log.ts";
import { tokens } from "../lib/tokens.ts";
import type { MemoryCapability } from "../memory/index.ts";
import type { ChatRequest, ToolCall } from "../providers/index.ts";
import { envelope } from "../sessions/index.ts";
import type { Offered, ToolContext, ToolResult } from "../tools/index.ts";
import { runOne, toolContext } from "./call.ts";
import { historyMessages, request } from "./context.ts";
import { memoryMessages } from "./memory-packet.ts";
import type { ContextLookups } from "./render.ts";
import { cutOpenTools, NOT_RUN, OVER_ROUND } from "./reply-rows.ts";
import { cutResult } from "./results.ts";
import type { RoundDeps } from "./round.ts";
import { failureFields, runRound } from "./round.ts";
import { type ActiveSend, nextRound } from "./send.ts";
import type { Writer } from "./writer.ts";
import { statusOf } from "./writer.ts";
import type { SessionsPort } from "./writer-port.ts";

export type MemoryCommitDeps = {
  memory: Pick<MemoryCapability, "commit">;
};

// an edited own note is committed on any cause once its phase started
export function commitMemory(
  deps: MemoryCommitDeps,
  send: ActiveSend,
): number | null {
  const work = send.policy.memoryOffered?.memory?.work ?? null;
  if (work === null || work.operations.length === 0) return null;
  const skipped = deps.memory.commit(work, send.sessionId).skipped;
  return skipped === 0 ? null : skipped;
}

export function hasMemoryPhase(send: ActiveSend): boolean {
  return (
    send.policy.automation?.ownMemory === true &&
    send.policy.memoryOffered !== null &&
    send.policy.memoryOffered.memory !== null &&
    (send.cause === "finish" ||
      send.cause === "deadline" ||
      send.cause === "failure")
  );
}

type PhaseRowsDeps = {
  db: Db;
  clock: Clock;
  sessions: SessionsPort;
  log: Log;
};

// the main round's open rows at the run's cut, its completions kept
export function stopMainTools(deps: PhaseRowsDeps, send: ActiveSend): void {
  if (send.openTools.size === 0) return;
  const now = deps.clock();
  transact(deps.db, () => {
    const rows = cutOpenTools(
      deps,
      send,
      send.policy.offered,
      send.cause ?? "failure",
      now,
    );
    if (rows.length === 0) return { result: undefined, events: [] };
    const session = deps.sessions.touch(send.sessionId, {
      status: "running",
      now,
    })!;
    return { result: undefined, events: [envelope(session, rows, null)] };
  });
  send.openTools = new Map();
  send.settled = new Map();
}

function startMemory(writer: Writer, send: ActiveSend): void {
  if (send.cause === null) throw new Error("the run has no ending");
  const memoryRound = send.roundNo + 1;
  // the first round after the run stays the attention step's, when it
  // had one
  const reply = writer.startAfterAnswer(send, {
    row: "work",
    status: statusOf(send.cause),
    error: send.error,
    counters: { memoryRound, memoryFrom: memoryRound },
  });
  send.memoryRound ??= memoryRound;
  send.memoryFrom = memoryRound;
  nextRound(send, reply, "memory");
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
    send.memoryFrom === null ||
    send.cause === null
  ) {
    throw new Error("the memory phase has no run context");
  }
  const from = send.memoryFrom;
  const messages = memoryMessages(
    {
      automation: send.policy.automation.name,
      sendId: send.id,
      memoryRound: send.memoryRound,
      cause: send.cause,
      error: send.error,
      rows,
      guidance: send.policy.automation.memoryGuidance,
      entries: offered.memory?.work?.entries ?? [],
    },
    {
      phase: historyMessages(
        rows.filter((row) => row.sendId === send.id && row.round >= from),
        send.policy,
        lookups,
      ),
      wire: send.policy.wire,
      model: send.policy.model,
      tools: offered.tools,
      contextLength: send.policy.contextLength,
      reserve: send.policy.limits.contextReserve,
    },
    tokens,
  );
  if (messages === null) return null;
  return request(send.policy, send.sessionId, messages, offered.tools);
}

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
    const ctx = toolContext(
      send,
      signal,
      deps.clock,
      { web: null },
      send.openTools.get(call)!.rowId,
    );
    const result = await runOne(deps, send, offered, call, ctx);
    try {
      const stored = cutResult(result, send.policy.toolCaps.resultCut);
      // kept until a row holds it, so the cut writes an edit that ended
      send.settled.set(call, stored);
      if (signal.aborted) return;
      if (result.error || call.name !== "memory_edit") clean = false;
      spend.resultBytes += Buffer.byteLength(stored.content);
      deps.writer.finishTool(send, call, stored);
    } catch (error) {
      if (!signal.aborted) writeError ??= error;
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
    logName?(offered: Offered, call: ToolCall): string;
  };
  log: Log;
  historyOf(send: ActiveSend): Message[];
};

export async function memoryPhase(
  deps: MemoryPhaseDeps,
  send: ActiveSend,
): Promise<void> {
  const offered = send.policy.memoryOffered;
  if (
    offered === null ||
    offered.memory === null ||
    send.ending.signal.aborted
  ) {
    return;
  }
  startMemory(deps.writer, send);
  // an earlier step's window is not this phase's cut
  send.cutBy = null;
  const controller = new AbortController();
  send.controller = controller;
  const stop = () => {
    send.memoryStopped = true;
    controller.abort();
  };
  send.ending.signal.addEventListener("abort", stop, { once: true });
  if (send.ending.signal.aborted) stop();
  // the phase runs past the turn's deadline, within its own window
  const deadline = deps.clock() + send.policy.limits.memoryPhaseMs;
  const disarm = after(deps.clock, send.policy.limits.memoryPhaseMs, () => {
    send.cutBy ??= "deadline";
    stop();
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
          deadline,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        deps.log.warn("round failed", {
          chat: send.sessionId,
          round: send.roundNo,
          ...failureFields(error),
        });
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
      nextRound(send, deps.writer.startRound(send), "memory");
      rounds += 1;
    }
  } finally {
    disarm();
    send.ending.signal.removeEventListener("abort", stop);
  }
}
