// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Log } from "../lib/log.ts";
import {
  type MemoryPhaseDeps,
  memoryPhase,
  stopMainTools,
} from "./memory-phase.ts";
import type { ActiveSend } from "./send.ts";
import type { Writer } from "./writer.ts";

export const FINALIZE_ATTEMPTS = 3;
export const FINALIZE_RETRY_MS = 100;

export type EndingDeps = {
  writer: Writer;
  phase: MemoryPhaseDeps;
  pause(ms: number): Promise<void>;
  log: Log;
};

function words(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  deps.log(
    `chat ${send.sessionId} could not be finalized: ${String(lastError)}`,
  );
  return false;
}

function hasMemoryPhase(send: ActiveSend): boolean {
  return (
    send.policy.automation?.ownMemory === true &&
    send.policy.memoryOffered !== null &&
    send.policy.memoryOffered.memory !== null &&
    (send.cause === "finish" ||
      send.cause === "deadline" ||
      send.cause === "failure")
  );
}

export async function endSend(
  deps: EndingDeps,
  send: ActiveSend,
): Promise<boolean> {
  if (send.cause === null) throw new Error("the send has no ending");
  try {
    if (send.tools !== null) await send.tools;
    stopMainTools(deps.phase, send);
  } catch (error) {
    send.memoryError = words(error);
  }
  if (hasMemoryPhase(send) && !send.ending.signal.aborted) {
    try {
      await memoryPhase(deps.phase, send);
    } catch (error) {
      send.memoryError = words(error);
    }
  }
  const finalized = await finalize(deps, send);
  deps.log(
    `chat ${send.sessionId} ${send.cause}${
      send.error === null ? "" : `: ${send.error}`
    }`,
  );
  send.end(finalized);
  return finalized;
}
