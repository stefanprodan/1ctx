// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A run's attention step: after the main rounds of a finished run, before
// its memory phase, the run's own model is asked over the run's record
// whether a user needs to act, with needs_attention alone on offer
// (attention-packet.ts). Its rows are work after the answer, drawn with
// the memory phase's in one group. Its reason waits on the step's handle
// and is written with the run's end (marks.ts), so the ending envelope
// carries it. It runs past the run's deadline in its own window, never
// fails the run, and a failure or an abort of it marks nothing.

import type { Message } from "../../shared/contracts/session.ts";
import { after, type Clock } from "../lib/clock.ts";
import type { Log } from "../lib/log.ts";
import { tokens } from "../lib/tokens.ts";
import type { ChatRequest, ToolCall } from "../providers/index.ts";
import type { Offered, ToolContext, ToolResult } from "../tools/index.ts";
import { asksAgain, attentionMessages } from "./attention-packet.ts";
import { runOne, toolContext } from "./call.ts";
import { historyMessages, requestBase } from "./context.ts";
import { runMark } from "./marks.ts";
import { leastThinking } from "./policy.ts";
import type { ContextLookups } from "./render.ts";
import { OVER_ROUND } from "./reply-rows.ts";
import type { RoundDeps } from "./round.ts";
import { failureFields, runRound } from "./round.ts";
import { type ActiveSend, nextRound } from "./send.ts";
import type { Writer } from "./writer.ts";
import { statusOf } from "./writer.ts";

// One small request, twice at most: 2.5 s on average on a local model in
// the eval. A minute covers a local server reading the record cold and a
// second round, and holds the run's slot no longer than that.
export const ATTENTION_STEP_MS = 60_000;
// what the eval measured, enough for a model that must think
export const ATTENTION_MAX_TOKENS = 4000;

export type AttentionStepDeps = {
  clock: Clock;
  round: RoundDeps;
  writer: Writer;
  tools: {
    run(
      offered: Offered,
      call: ToolCall,
      ctx: ToolContext,
    ): Promise<ToolResult>;
    logName?(offered: Offered, call: ToolCall): string;
  };
  log: Log;
  historyOf(send: ActiveSend): Message[];
};

// a finished run of an automation not off, on a model that takes tools,
// which the runner did not mark and no Stop ended
export function hasAttentionStep(send: ActiveSend): boolean {
  return (
    send.kind === "run" &&
    send.cause === "finish" &&
    send.policy.automation !== null &&
    send.policy.automation.attentionMode !== "off" &&
    (send.policy.attentionOffered?.attention ?? null) !== null &&
    runMark(send, "finish") === null &&
    !send.ending.signal.aborted
  );
}

function startStep(deps: AttentionStepDeps, send: ActiveSend): void {
  const first = send.roundNo + 1;
  const reply = deps.writer.startAfterAnswer(send, {
    row: "work",
    status: statusOf(send.cause!),
    error: send.error,
    counters: { memoryRound: first, attentionRound: first },
  });
  send.memoryRound = first;
  send.attentionRound = first;
  nextRound(send, reply, "attention");
}

// asked with thinking off, the step called the tool every time; with
// thinking on, a local model reasoned it should and wrote the call out
// as text
function stepRequest(
  send: ActiveSend,
  rows: Message[],
  offered: Offered,
  lookups: ContextLookups,
  again: boolean,
): ChatRequest | null {
  const automation = send.policy.automation;
  const from = send.attentionRound;
  if (automation === null || from === null) {
    throw new Error("the attention step has no run context");
  }
  const messages = attentionMessages(
    {
      automation: automation.name,
      sendId: send.id,
      before: from,
      rows,
      guidance: automation.attentionGuidance,
    },
    {
      step: historyMessages(
        rows.filter((row) => row.sendId === send.id && row.round >= from),
        send.policy,
        lookups,
      ),
      again,
      wire: send.policy.wire,
      model: send.policy.model,
      tools: offered.tools,
      contextLength: send.policy.contextLength,
      reserve: send.policy.limits.contextReserve,
    },
    tokens,
  );
  if (messages === null) return null;
  return {
    ...requestBase(send.policy, send.sessionId, messages),
    ...leastThinking(send.policy),
    maxTokens: ATTENTION_MAX_TOKENS,
    tools: offered.tools,
  };
}

// the round's calls in order, so a later reason replaces an earlier one;
// any other name is refused by the step's set
async function runCalls(
  deps: AttentionStepDeps,
  send: ActiveSend,
  offered: Offered,
  calls: ToolCall[],
  signal: AbortSignal,
): Promise<void> {
  for (const call of calls) {
    if (signal.aborted) return;
    const ctx = toolContext(
      send,
      signal,
      deps.clock,
      { web: null },
      send.openTools.get(call)!.rowId,
    );
    const result = await runOne(deps, send, offered, call, ctx);
    // kept until a row holds it, so the cut writes a call that ended
    send.settled.set(call, result);
    if (signal.aborted) return;
    deps.writer.finishTool(send, call, result);
  }
}

// a round of calls: the reply done as work, then its calls run; false
// when there were more calls than a round may run, none of them run
async function callRound(
  deps: AttentionStepDeps,
  send: ActiveSend,
  offered: Offered,
  signal: AbortSignal,
): Promise<boolean> {
  const calls = send.round?.calls ?? [];
  if (calls.length > send.policy.limits.callsPerRound) {
    deps.writer.recordUnrun(send, "attention_limit", calls, OVER_ROUND);
    send.round = null;
    return false;
  }
  send.budget.calls = deps.writer.finishRound(send).toolCalls;
  send.round = null;
  await runCalls(deps, send, offered, calls, signal);
  return true;
}

export async function attentionStep(
  deps: AttentionStepDeps,
  send: ActiveSend,
): Promise<void> {
  const offered = send.policy.attentionOffered;
  const handle = offered?.attention ?? null;
  if (offered === null || handle === null || send.ending.signal.aborted) {
    return;
  }
  send.cutBy = null;
  const controller = new AbortController();
  let timedOut = false;
  const stop = () => {
    send.attentionStopped = true;
    controller.abort();
  };
  send.ending.signal.addEventListener("abort", stop, { once: true });
  const disarm = after(deps.clock, ATTENTION_STEP_MS, () => {
    timedOut = true;
    send.cutBy ??= "deadline";
    stop();
  });
  const deadline = deps.clock() + ATTENTION_STEP_MS;
  try {
    startStep(deps, send);
    let again = false;
    for (let rounds = 1; !controller.signal.aborted; rounds++) {
      const rows = deps.historyOf(send);
      const request = stepRequest(
        send,
        rows,
        offered,
        deps.round.lookups,
        again,
      );
      if (request === null) throw new Error("the attention step did not fit");
      await runRound(deps.round, send, rows, {
        request,
        signal: controller.signal,
        deadline,
      });
      const round = send.round;
      if (controller.signal.aborted || round === null) break;
      // text never marks: "ok" ends the step, anything else is asked
      // again once, the reply kept as the step's work
      if (round.calls.length === 0) {
        if (!asksAgain(rounds, round, false)) break;
        deps.writer.finishRound(send, []);
        again = true;
      } else {
        again = false;
        if (!(await callRound(deps, send, offered, controller.signal))) break;
        if (!asksAgain(rounds, round, handle.reason !== null)) break;
      }
      nextRound(send, deps.writer.startRound(send), "attention");
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      send.attentionError = error instanceof Error ? error.message : "failed";
      deps.log.warn("attention step failed", {
        chat: send.sessionId,
        ...failureFields(error),
      });
    }
  } finally {
    disarm();
    send.ending.signal.removeEventListener("abort", stop);
  }
  if (controller.signal.aborted) {
    // a reason made before the abort is dropped with the rest
    handle.reason = null;
    if (timedOut) {
      send.attentionStopped = false;
      send.attentionError = "the attention step ran out of time";
      deps.log.warn("attention step failed", {
        chat: send.sessionId,
        cause: "timeout",
      });
    } else {
      deps.log.info("attention step stopped", { chat: send.sessionId });
    }
  } else if (send.attentionError !== null) {
    handle.reason = null;
  }
}
