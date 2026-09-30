// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A round's output cap: the model's own limit, bounded and fitted to the
// room its prompt leaves in the window, as OpenCode sizes it. The cap is
// an estimate and never stops a turn.

import { tokens } from "../lib/tokens.ts";
import {
  type ChatMessageIn,
  type ChatRequest,
  requestTokens,
} from "../providers/index.ts";
import type { SendPolicy } from "./policy.ts";

// used when the catalog has no output limit for the model
export const OUTPUT_FALLBACK = 32_000;
// no reply needs more, however much the model allows
export const OUTPUT_MAX = 256_000;
// what is counted here is o200k, which can run low on another vendor's
// tokens and on dense text such as code
export const ESTIMATE_ERROR = 0.15;
// never ask for less: a short reply is still an answer, and the
// estimate may overstate the prompt
export const OUTPUT_MIN = 1_024;

// the most tokens a round asks for: the model's own limit, bounded, and
// fitted to the room the prompt leaves in the window when it is known.
// measured is what the provider counted of the prompt so far, estimated
// what was added since and counted here, the part that may run low
export function outputCap(
  outputLimit: number | null,
  contextLength: number | null,
  measured: number,
  estimated: number,
): number {
  const requested = Math.min(outputLimit ?? OUTPUT_FALLBACK, OUTPUT_MAX);
  if (contextLength === null) return requested;
  const room =
    contextLength - measured - Math.ceil(estimated * (1 + ESTIMATE_ERROR));
  return Math.min(requested, Math.max(OUTPUT_MIN, room));
}

// the last round the provider counted: its prompt and reply in tokens,
// and the messages it was sent, which the next round's request extends
export type Measured = { tokens: number; messages: ChatMessageIn[] };

// a round's request with its cap, and the prompt's size in tokens when
// it was counted (null when no window asked for it); skipped holds what
// made the count fail, and the request then goes without a cap
export type Sized = {
  request: ChatRequest;
  estimate: number | null;
  skipped?: unknown;
};

// the messages a request added after the measured ones, or null when
// it does not extend them (the first round, a phase's own packet)
function addedSince(
  messages: ChatMessageIn[],
  measured: Measured | null,
): ChatMessageIn[] | null {
  if (measured === null) return null;
  const before = measured.messages;
  if (before.length === 0 || before.length > messages.length) return null;
  const at = before.length - 1;
  if (JSON.stringify(before[at]) !== JSON.stringify(messages[at])) {
    return null;
  }
  return messages.slice(before.length);
}

// a chat, run or memory round with its cap. A model whose limit was
// never read sends none, as before the catalog kept it; the prompt is
// counted only when there is a window to fit, and then only what the
// last counted round did not cover. The cap is an estimate and never
// stops a turn: a count that throws sends the round without one
export function sized(
  req: ChatRequest,
  policy: Pick<SendPolicy, "outputLimit" | "outputRead" | "contextLength">,
  measured: Measured | null = null,
): Sized {
  try {
    return capped(req, policy, measured);
  } catch (error) {
    return { request: req, estimate: null, skipped: error };
  }
}

function capped(
  req: ChatRequest,
  policy: Pick<SendPolicy, "outputLimit" | "outputRead" | "contextLength">,
  measured: Measured | null,
): Sized {
  if (!policy.outputRead) return { request: req, estimate: null };
  let base = 0;
  let estimated = 0;
  let estimate: number | null = null;
  if (policy.contextLength !== null) {
    const added = addedSince(req.messages, measured);
    if (added === null) {
      estimated = requestTokens(req);
      estimate = estimated;
    } else {
      base = measured!.tokens;
      estimated = tokens(JSON.stringify(added));
      estimate = base + estimated;
    }
  }
  return {
    request: {
      ...req,
      maxTokens: outputCap(
        policy.outputLimit,
        policy.contextLength,
        base,
        estimated,
      ),
    },
    estimate,
  };
}
