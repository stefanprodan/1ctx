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
import type { ToolCall } from "../providers/index.ts";
import { isMemoryTool } from "../tools/index.ts";
import type { ToolContext, ToolResult, ToolsPort } from "./policy.ts";
import type { RoundDeps } from "./round.ts";
import { runRound } from "./round.ts";
import { type ActiveSend, newRound } from "./send.ts";
import type { Writer } from "./writer.ts";

// how many identical rounds in a row are the loop check
export const LOOP_REPEATS = 3;
export type LoopDeps = {
  round: RoundDeps;
  writer: Writer;
  tools: ToolsPort;
  clock: Clock;
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

// the cut a result gets before the byte cap weighs it
function cut(result: ToolResult, resultChars: number): ToolResult {
  if (result.content.length <= resultChars) return result;
  return { ...result, content: result.content.slice(0, resultChars) };
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
    await runRound(deps.round, send, deps.historyOf(send));
    if (send.cause !== null) return endFor(send.cause);
    const round = send.round;
    if (round === null) return finish();
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

    // an answer round can open the one final summary round, the capped
    // answer round included: it is the request the tool results filled
    if (calls.length === 0) {
      const threshold = compactsAt(
        send.policy.contextLength,
        limits.contextReserve,
      );
      const usage = round.usage;
      if (
        send.kind === "chat" &&
        usage !== null &&
        threshold !== null &&
        usage.promptTokens + usage.completionTokens >= threshold
      ) {
        const summary = deps.writer.startSummary(send);
        send.summarizing = true;
        send.used = usage.promptTokens + usage.completionTokens;
        send.roundNo += 1;
        send.phase = "provider";
        send.round = newRound(summary.id, summary.createdAt);
        continue;
      }
      return finish();
    }

    // calls in the answer round: keep work, record them not run, end
    if (send.answering) {
      deps.writer.recordUnrun(send, "tool_limit", calls);
      send.round = null;
      return { cause: "finish", finishReason: "tool_limit", error: null };
    }

    // a finish reason other than stop or tool_calls with calls present:
    // record them not run and end on that reason
    const reason = round.finishReason ?? "";
    if (reason !== "stop" && reason !== "tool_calls") {
      deps.writer.recordUnrun(send, reason, calls);
      send.round = null;
      return { cause: "finish", finishReason: reason, error: null };
    }

    // the loop check: three equal signatures in a row
    send.signatures.push(signature(calls));
    if (looping(send.signatures)) {
      deps.writer.recordUnrun(send, "tool_loop", calls);
      send.round = null;
      return { cause: "finish", finishReason: "tool_loop", error: null };
    }

    // the caps, weighed before the calls launch
    if (overCap(send, calls, limits)) {
      goToAnswer(deps, send, calls);
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
    await runCalls(deps, send, calls);
    if (send.cause !== null) return endFor(send.cause);

    startNextRound(deps, send);
  }
}

// the caps, in the order the plan weighs them; a send at a cap goes to
// the answer round rather than launching this round's calls
function overCap(
  send: ActiveSend,
  calls: ToolCall[],
  limits: ActiveSend["policy"]["limits"],
): boolean {
  if (calls.length > limits.callsPerRound) return true;
  if (send.budget.calls + calls.length > limits.callsPerSend) return true;
  if (send.roundNo >= limits.rounds - 1) return true;
  if (send.budget.toolMs >= limits.toolMs) return true;
  if (send.budget.resultBytes >= limits.resultBytes) return true;
  return false;
}

// the round's tools launch in parallel under the call timeout and the
// send's signal; each end is one finishTool, guarded by streaming. A
// finishTool that throws terminates the send; the siblings still settle
async function runCalls(
  deps: LoopDeps,
  send: ActiveSend,
  calls: ToolCall[],
): Promise<void> {
  const startedAt = deps.clock();
  let writeError: unknown = null;
  const settled = calls.map(async (call) => {
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
    };
    let result: ToolResult;
    try {
      result = await deps.tools.run(send.policy.offered, call, ctx);
    } catch (err) {
      // a tool that throws is a failed result whose content is the error
      result = {
        content: err instanceof Error ? err.message : String(err),
        error: true,
      };
    }
    // A terminal transaction may be between retries. Do not let a tool
    // that settled after the claim write into that rollback window.
    if (send.cause !== null) return;
    const stored = cut(result, send.policy.toolCaps.resultCut);
    send.budget.resultBytes += bytes(stored.content);
    try {
      deps.writer.finishTool(send, call, stored);
    } catch (err) {
      // Claim failure immediately so the send aborts siblings; they still
      // settle under the round's allSettled before the lock is released.
      if (writeError === null) {
        writeError = err;
        deps.fail(send, err instanceof Error ? err.message : String(err));
      }
    }
  });
  const task = Promise.allSettled(settled).then(() => {});
  send.tools = task;
  await task;
  const offered = send.policy.offered;
  offered.memory?.settleRound();
  if (offered.memory?.stopped) {
    offered.tools = offered.tools.filter((tool) => !isMemoryTool(tool.name));
  }
  send.tools = null;
  send.budget.toolMs += deps.clock() - startedAt;
  if (writeError !== null) throw writeError;
}

// enter the answer round: keep the tools, forbid a call
function goToAnswer(deps: LoopDeps, send: ActiveSend, calls: ToolCall[]): void {
  send.answering = true;
  const reply = deps.writer.startRound(send, {
    finishReason: "tool_limit",
    calls,
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
