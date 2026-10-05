// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { messageOf } from "../lib/errors.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { Attention } from "./attention.ts";
import { attentionStep, hasAttentionStep } from "./attention-step.ts";
import {
  hasMemoryPhase,
  type MemoryPhaseDeps,
  memoryPhase,
  stopMainTools,
} from "./memory-phase.ts";
import { refusalFields } from "./round.ts";
import type { ActiveSend } from "./send.ts";
import type { Writer } from "./writer.ts";
import { statusOf } from "./writer.ts";

export const FINALIZE_ATTEMPTS = 3;
export const FINALIZE_RETRY_MS = 100;

export type EndingDeps = {
  writer: Writer;
  phase: MemoryPhaseDeps;
  pause(ms: number): Promise<void>;
  log: Log;
  attention: Pick<Attention, "ask">;
};

async function finalize(deps: EndingDeps, send: ActiveSend): Promise<boolean> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < FINALIZE_ATTEMPTS; attempt++) {
    try {
      deps.writer.finalizeSend(send, send.cause!, send.error);
      send.terminal = send.cause;
      send.phase = "terminal";
      return true;
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < FINALIZE_ATTEMPTS) {
      await deps.pause(FINALIZE_RETRY_MS);
    }
  }
  deps.log.error("chat finalize failed", {
    chat: send.sessionId,
    ...errorFields(lastError),
  });
  return false;
}

export async function endSend(
  deps: EndingDeps,
  send: ActiveSend,
): Promise<boolean> {
  if (send.cause === null) throw new Error("the send has no ending");
  // before the memory phase, so its mark is written with the run's end
  // and the phase's record is the run's alone
  if (hasAttentionStep(send)) {
    try {
      await attentionStep(deps.phase, send);
    } catch (error) {
      deps.log.warn("attention step failed", {
        chat: send.sessionId,
        ...errorFields(error),
      });
    }
  }
  if (hasMemoryPhase(send)) {
    try {
      // the phase writes rows of its own, so the main round's tools
      // have to let go first and its open rows are stopped before the
      // phase's first round replaces the map. A send with no phase
      // finalizes at once and finalizeSend stops those rows, as it
      // always has, so a tool that ignores the abort never holds the
      // run open
      if (send.tools !== null) await send.tools;
      if (!send.ending.signal.aborted) {
        stopMainTools(deps.phase, send);
        await memoryPhase(deps.phase, send);
      }
    } catch (error) {
      send.memoryError = messageOf(error);
    }
  }
  const finalized = await finalize(deps, send);
  const log = send.cause === "failure" ? deps.log.error : deps.log.info;
  log("send end", {
    chat: send.sessionId,
    op: send.op,
    cause: send.cause,
    status: statusOf(send.cause),
    rounds: send.roundNo,
    tools: send.budget.calls,
    prompt_tokens: send.promptTokens,
    completion_tokens: send.completionTokens,
    spent_tokens: send.budget.tokens,
    duration: deps.phase.clock() - send.startedAt,
    ...(send.error === null
      ? {}
      : send.refusal !== null
        ? refusalFields(send.refusal.status)
        : errorFields(send.error, false)),
  });
  send.end(finalized);
  // after the done state and its frames, so the ask never holds the run
  if (finalized) deps.attention.ask(send);
  return finalized;
}
