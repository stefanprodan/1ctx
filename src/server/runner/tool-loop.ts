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
import { messageOf } from "../lib/errors.ts";
import type { Log } from "../lib/log.ts";
import type { ToolCall } from "../providers/index.ts";
import { DELEGATE_TOOL, isMemoryTool } from "../tools/index.ts";
import { runOne, toolContext } from "./call.ts";
import { ASK_TOKENS } from "./context.ts";
import type { ToolResult, ToolsPort } from "./policy.ts";
import { NOT_RUN_REPEAT, notRun } from "./reply-rows.ts";
import { cutResult, fitResults, resultsFit } from "./results.ts";
import type { RoundDeps } from "./round.ts";
import { failureFields, runRound } from "./round.ts";
import { type ActiveSend, type CapReason, nextRound } from "./send.ts";
import { dropTextCalls } from "./text-calls.ts";
import type { Writer } from "./writer.ts";

// the finish reason of an answer whose call written as text was dropped
const TEXT_CALL_REASON = "tool_text";
// the finish reason of a work round whose repeated calls were refused
const REPEAT_REASON = "tool_repeat";

// how many identical rounds in a row are the loop check
const LOOP_REPEATS = 3;

export type LoopDeps = {
  round: RoundDeps;
  writer: Writer;
  tools: ToolsPort;
  clock: Clock;
  log: Log;
  historyOf(send: ActiveSend): Message[];
  fail(send: ActiveSend, error: string): void;
};

// how the loop asks the send to end
type LoopEnd = { cause: SendCause; error: string | null };

const finish = (): LoopEnd => ({ cause: "finish", error: null });

// the names and arguments of a round's calls, sorted, so a repeat is
// the same set whatever the order
function signature(calls: ToolCall[]): string {
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
          ...failureFields(error),
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
        ? { cause: "failure", error: "the summary came back empty" }
        : finish();
    }
    send.budget.tokens += round.spent;

    // an answer round can open the one final summary round, the capped
    // answer round included: it is the request the tool results filled
    if (calls.length === 0) {
      // a call written as text in the retry without schemas is never
      // kept as the answer
      const kept = send.bare ? dropTextCalls(round.content) : null;
      if (kept !== null) {
        round.content = kept;
        round.finishReason = TEXT_CALL_REASON;
      }
      const threshold = compactsAt(
        send.policy.contextLength,
        limits.contextReserve,
      );
      // a summoned turn never compacts: compaction is the chat agent's;
      // nor a subagent, whose answer at the threshold is its last
      if (
        send.kind === "chat" &&
        send.policy.summoned === null &&
        send.child === null &&
        threshold !== null &&
        round.tokens >= threshold
      ) {
        const summary = deps.writer.startSummary(send);
        send.summarizing = true;
        // a round with no usage holds its request estimate without the
        // answer, which must not pass as measured
        send.used = round.usage === null ? null : round.tokens;
        nextRound(send, summary, "provider");
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
      return finish();
    }

    // a finish reason other than stop or tool_calls with calls present:
    // record them not run and end on that reason
    const reason = round.finishReason ?? "";
    if (reason !== "stop" && reason !== "tool_calls") {
      deps.writer.recordUnrun(send, reason, calls);
      send.round = null;
      return finish();
    }

    // the loop check: three equal signatures in a row are refused once
    // and the loop goes on, since a model often moves on when told; a
    // second trip, or one with no round left, asks for the answer
    send.signatures.push(signature(calls));
    if (looping(send.signatures)) {
      if (!send.loopWarned && send.roundNo < limits.rounds - 2) {
        send.loopWarned = true;
        send.signatures = [];
        deps.writer.recordUnrun(send, REPEAT_REASON, calls, NOT_RUN_REPEAT);
        startNextRound(deps, send);
        continue;
      }
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
    // leave room for the ask the answer round ends its request with
    const room =
      threshold === null
        ? null
        : Math.max(0, threshold - round.tokens - ASK_TOKENS);
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
// finishTool that throws terminates the send; the siblings still settle.
// Every end is kept on the send until a row holds it, so a cut that
// lands before it is stored still writes a completion whole.
// toolMs adds the ordinary calls' time alone: a delegate call's is its
// child's, bounded by the send's deadline and its own budget
async function runCalls(
  deps: LoopDeps,
  send: ActiveSend,
  calls: ToolCall[],
  room: number | null,
): Promise<boolean> {
  const startedAt = deps.clock();
  let ordinaryEnd = startedAt;
  const immediate = resultsFit(calls, send.policy.toolCaps.resultCut, room);
  let writeError: unknown = null;
  const store = (call: ToolCall, result: ToolResult) => {
    if (send.cause !== null) return;
    send.budget.resultBytes += Buffer.byteLength(result.content);
    deps.writer.finishTool(send, call, result);
  };
  const settled = calls.map(async (call) => {
    const ctx = toolContext(
      send,
      send.controller.signal,
      deps.clock,
      {
        web: send.policy.web,
        keep: send.keep,
        repos: send.repos?.tool ?? null,
      },
      send.openTools.get(call)!.rowId,
    );
    const result = await runOne(deps, send, send.policy.offered, call, ctx);
    if (call.name !== DELEGATE_TOOL) {
      ordinaryEnd = Math.max(ordinaryEnd, deps.clock());
    }
    let stored = result;
    try {
      stored = cutResult(result, send.policy.toolCaps.resultCut);
      send.settled.set(call, stored);
      if (immediate) store(call, stored);
    } catch (err) {
      writeError ??= err;
      deps.fail(send, messageOf(err));
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
    // tails past the room still go to the answer round: the reserve
    // above the threshold holds them, and failing would lose the turn
    for (let i = 0; i < calls.length; i++) {
      store(calls[i]!, fitted.results[i]!);
    }
  });
  send.tools = task;
  try {
    await task;
  } catch (err) {
    deps.fail(send, messageOf(err));
    throw err;
  } finally {
    const offered = send.policy.offered;
    offered.memory?.settleRound();
    if (offered.memory?.stopped) {
      offered.tools = offered.tools.filter((tool) => !isMemoryTool(tool.name));
    }
    send.tools = null;
    send.budget.toolMs += ordinaryEnd - startedAt;
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
  nextRound(send, reply, "provider");
}

// between rounds while tools run: no row streams
function goToTools(send: ActiveSend): void {
  send.phase = "tools";
  send.round = null;
}

function startNextRound(deps: LoopDeps, send: ActiveSend): void {
  nextRound(send, deps.writer.startRound(send), "provider");
}

// the cause a terminal transition set maps to a loop end; run() will
// call terminate() with the same cause, which is a no-op the second time
function endFor(cause: SendCause): LoopEnd {
  return { cause, error: null };
}
