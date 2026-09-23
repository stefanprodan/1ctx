// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The loop run() drives, once per send. Each round is one provider turn
// (round.ts), then the loop decides: a normal end with no calls is the
// answer and the send finishes; calls that a cap, the loop check or the
// answer round forbids are recorded not run and the send ends on that
// reason; calls to run launch in parallel under the call timeout and the
// send's signal, their ends written one by one, and the next round
// begins. Every exit goes through terminate(), never finalizeSend.

import { compactsAt } from "../../shared/compaction.ts";
import type { Message } from "../../shared/contracts/session.ts";
import type { SendCause } from "../../shared/words.ts";
import type { Clock } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import { tokens } from "../lib/tokens.ts";
import type { ToolCall } from "../providers/index.ts";
import { isMemoryTool } from "../tools/index.ts";
import { EXHAUSTED_LINE } from "./context.ts";
import type { ToolContext, ToolResult, ToolsPort } from "./policy.ts";
import { cutResult, fitResults, resultsFit } from "./results.ts";
import type { RoundDeps } from "./round.ts";
import { runRound } from "./round.ts";
import { type ActiveSend, type CapReason, newRound } from "./send.ts";
import { notRun, type Writer } from "./writer.ts";

// how many identical rounds in a row are the loop check
export const LOOP_REPEATS = 3;
export type LoopDeps = {
  round: RoundDeps;
  writer: Writer;
  tools: ToolsPort;
  clock: Clock;
  log: Log;
  historyOf(send: ActiveSend): Message[];
  fail(send: ActiveSend, error: string): void;
};

// how the loop asks the send to end: a cause and, for the runner's own
// reasons, the finish_reason to leave on the reply
export type LoopEnd = {
  cause: SendCause;
  finishReason: string | null;
  error: string | null;
};

const finish = (): LoopEnd => ({
  cause: "finish",
  finishReason: null,
  error: null,
});

// the names and arguments of a round's calls, sorted, so a repeat is
// the same set whatever the order
export function signature(calls: ToolCall[]): string {
  return calls
    .map((call) => `${call.name}(${call.arguments})`)
    .sort()
    .join("\n");
}

// three equal signatures in a row
function looping(signatures: string[]): boolean {
  if (signatures.length < LOOP_REPEATS) return false;
  const last = signatures.slice(-LOOP_REPEATS);
  return last.every((s) => s === last[0]);
}

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

// the loop; returns how the send should end, which run() hands to
// terminate(). Terminal is rechecked after every await
export async function toolLoop(
  deps: LoopDeps,
  send: ActiveSend,
): Promise<LoopEnd> {
  const limits = send.policy.limits;
  while (true) {
    if (send.cause !== null) return endFor(send.cause);
    try {
      await runRound(deps.round, send, deps.historyOf(send));
    } catch (error) {
      if (!send.controller.signal.aborted) {
        deps.log.warn("round failed", {
          chat: send.sessionId,
          round: send.roundNo,
          ...errorFields(error, false),
        });
      }
      throw error;
    }
    if (send.cause !== null) return endFor(send.cause);
    const round = send.round;
    if (round === null) return finish();
    round.calls =
      deps.tools.normalize?.(send.policy.offered, round.calls) ?? round.calls;
    const calls = round.calls;

    if (send.summarizing) {
      return round.content.trim() === ""
        ? {
            cause: "failure",
            finishReason: round.finishReason,
            error: "the summary came back empty",
          }
        : finish();
    }
    send.budget.tokens += round.tokens;

    // an answer round can open the one final summary round, the capped
    // answer round included: it is the request the tool results filled
    if (calls.length === 0) {
      const threshold = compactsAt(
        send.policy.contextLength,
        limits.contextReserve,
      );
      if (
        send.kind === "chat" &&
        threshold !== null &&
        round.tokens >= threshold
      ) {
        const summary = deps.writer.startSummary(send);
        send.summarizing = true;
        send.used = round.tokens;
        send.roundNo += 1;
        send.phase = "provider";
        send.round = newRound(summary.id, summary.createdAt);
        continue;
      }
      return finish();
    }

    // calls in the answer round: keep work, record them not run, ask
    // once more without schemas, then end
    if (send.answering) {
      deps.writer.recordUnrun(
        send,
        send.answering,
        calls,
        notRun(send.answering),
      );
      // a request without schemas is a new prompt to a local server,
      // minutes for a long chat, so the same request goes first there;
      // a hosted wire's cache is not one conversation's to keep
      if (!send.repeated && send.policy.wire === "openai-compatible") {
        send.repeated = true;
        startNextRound(deps, send);
        continue;
      }
      if (!send.bare) {
        send.bare = true;
        startNextRound(deps, send);
        continue;
      }
      send.round = null;
      return { cause: "finish", finishReason: send.answering, error: null };
    }

    // a finish reason other than stop or tool_calls with calls present:
    // record them not run and end on that reason
    const reason = round.finishReason ?? "";
    if (reason !== "stop" && reason !== "tool_calls") {
      deps.writer.recordUnrun(send, reason, calls);
      send.round = null;
      return { cause: "finish", finishReason: reason, error: null };
    }

    // the loop check: three equal signatures in a row ask for the answer
    send.signatures.push(signature(calls));
    if (looping(send.signatures)) {
      goToAnswer(deps, send, "tool_loop", { calls });
      continue;
    }

    // the caps, weighed before the calls launch
    const cap = overCap(send, calls, limits);
    if (cap !== null) {
      goToAnswer(deps, send, cap, { calls });
      continue;
    }

    // launch the round's calls in parallel, record the send counters,
    // write one streaming tool row per call, then run them
    const toolNames = calls.map(
      (call) => deps.tools.toolName?.(send.policy.offered, call) ?? call.name,
    );
    send.budget.calls = deps.writer.finishRound(send, toolNames).toolCalls;
    if (send.cause !== null) return endFor(send.cause);
    goToTools(send);
    const threshold = compactsAt(
      send.policy.contextLength,
      limits.contextReserve,
    );
    // Leave the forced-answer instruction outside the stored result budget.
    const room =
      threshold === null
        ? null
        : Math.max(0, threshold - round.tokens - tokens(EXHAUSTED_LINE) - 4);
    const cut = await runCalls(deps, send, calls, room);
    if (send.cause !== null) return endFor(send.cause);

    if (cut) {
      goToAnswer(deps, send, "context_limit", { messageId: round.messageId });
    } else {
      startNextRound(deps, send);
    }
  }
}

function overCap(
  send: ActiveSend,
  calls: ToolCall[],
  limits: ActiveSend["policy"]["limits"],
): CapReason | null {
  if (calls.length > limits.callsPerRound) return "tool_limit";
  if (send.budget.calls + calls.length > limits.callsPerSend)
    return "tool_limit";
  if (send.roundNo >= limits.rounds - 1) return "tool_limit";
  if (send.budget.toolMs >= limits.toolMs) return "tool_limit";
  if (send.budget.resultBytes >= limits.resultBytes) return "tool_limit";
  if (send.budget.tokens >= limits.toolWorkTokens) return "token_limit";
  const threshold = compactsAt(
    send.policy.contextLength,
    limits.contextReserve,
  );
  if (threshold !== null && send.round!.tokens >= threshold)
    return "context_limit";
  return null;
}

// the round's tools launch in parallel under the call timeout and the
// send's signal; each end is one finishTool, guarded by streaming. A
// finishTool that throws terminates the send; the siblings still settle
async function runCalls(
  deps: LoopDeps,
  send: ActiveSend,
  calls: ToolCall[],
  room: number | null,
): Promise<boolean> {
  const startedAt = deps.clock();
  const immediate = resultsFit(calls, send.policy.toolCaps.resultCut, room);
  let writeError: unknown = null;
  const store = (call: ToolCall, result: ToolResult) => {
    if (send.cause !== null) return;
    send.budget.resultBytes += bytes(result.content);
    deps.writer.finishTool(send, call, result);
  };
  const settled = calls.map(async (call) => {
    const callStarted = deps.clock();
    const ctx: ToolContext = {
      actor: {
        projectId: send.projectId,
        userId: send.policy.userId,
        agentId: send.policy.agentId,
        agentName: send.policy.agentName,
        sessionId: send.sessionId,
        origin: send.kind === "run" ? "automation" : "chat",
      },
      signal: send.controller.signal,
      now: deps.clock,
      budget: send.toolBudget,
      caps: send.policy.toolCaps,
      web: send.policy.web,
      keep: send.keep,
    };
    let result: ToolResult;
    try {
      result = await deps.tools.run(send.policy.offered, call, ctx);
    } catch (err) {
      // a tool that throws is a failed result whose content is the error
      result = {
        content: err instanceof Error ? err.message : String(err),
        error: true,
        failure: err,
      };
    }
    if (result.error) {
      const tool =
        deps.tools.toolName?.(send.policy.offered, call) ?? call.name;
      deps.log.warn("tool failed", {
        chat: send.sessionId,
        tool,
        duration: deps.clock() - callStarted,
        ...(result.timedOut
          ? { cause: "timeout" }
          : errorFields(result.failure, false)),
      });
    }
    let stored = result;
    try {
      stored = cutResult(result, send.policy.toolCaps.resultCut);
      if (immediate) store(call, stored);
    } catch (err) {
      writeError ??= err;
      deps.fail(send, err instanceof Error ? err.message : String(err));
    }
    return stored;
  });
  let cut = false;
  const task = Promise.all(settled).then((results) => {
    if (writeError !== null) throw writeError;
    // A terminal transaction may be between retries.
    if (send.cause !== null || immediate) return;
    const fitted = fitResults(calls, results, room);
    cut = fitted.cut;
    for (let i = 0; i < calls.length; i++) {
      store(calls[i]!, fitted.results[i]!);
    }
    if (!fitted.fits) {
      throw new Error("the result tails do not fit the context");
    }
  });
  send.tools = task;
  try {
    await task;
  } catch (err) {
    deps.fail(send, err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    const offered = send.policy.offered;
    offered.memory?.settleRound();
    if (offered.memory?.stopped) {
      offered.tools = offered.tools.filter((tool) => !isMemoryTool(tool.name));
    }
    send.tools = null;
    send.budget.toolMs += deps.clock() - startedAt;
  }
  return cut;
}

function goToAnswer(
  deps: LoopDeps,
  send: ActiveSend,
  reason: CapReason,
  previous: { calls: ToolCall[] } | { messageId: string },
): void {
  send.answering = reason;
  const reply = deps.writer.startRound(send, {
    finishReason: reason,
    ...previous,
  });
  send.roundNo += 1;
  send.phase = "provider";
  send.round = newRound(reply.id, reply.createdAt);
}

// between rounds while tools run: no row streams
function goToTools(send: ActiveSend): void {
  send.phase = "tools";
  send.round = null;
}

// the next streaming reply: the round number bumps, phase back to
// provider, a fresh round state on the send
function startNextRound(deps: LoopDeps, send: ActiveSend): void {
  const reply = deps.writer.startRound(send);
  send.roundNo += 1;
  send.phase = "provider";
  send.round = newRound(reply.id, reply.createdAt);
}

// the cause a terminal transition set maps to a loop end; run() will
// call terminate() with the same cause, which is a no-op the second time
function endFor(cause: SendCause): LoopEnd {
  return { cause, finishReason: null, error: null };
}
