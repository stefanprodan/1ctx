// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The repetition watches of one attempt of a round: the answer text, the
// reasoning and each call's arguments, each its own. A tool's result is
// never fed.

import type { Log } from "../lib/log.ts";
import { tokens } from "../lib/tokens.ts";
import {
  type ChatEvent,
  type ChatRequest,
  requestTokens,
} from "../providers/index.ts";
import { RunawayWatch } from "./repetition.ts";
import type { ActiveSend, RoundState } from "./send.ts";

export type LoopChannel = "content" | "reasoning" | "arguments";
export type Loop = { channel: LoopChannel; chars: number };

function looped(
  channel: LoopChannel,
  watch: RunawayWatch,
  text: string,
): Loop | null {
  return watch.feed(text) ? { channel, chars: watch.chars } : null;
}

// the words a round that looped twice fails with, and the finish reason
// its row keeps for the fold
export const OUTPUT_LOOP = "the model was stopped due to output loop";
export const OUTPUT_LOOP_REASON = "output_loop";

export class RoundWatches {
  private readonly content = new RunawayWatch();
  private readonly reasoning = new RunawayWatch();
  private readonly calls = new Map<number, RunawayWatch>();

  // the channel the event made a loop and the characters it was fed,
  // or null
  feed(event: ChatEvent): Loop | null {
    switch (event.kind) {
      case "content":
        return looped("content", this.content, event.text);
      case "reasoning":
        return looped("reasoning", this.reasoning, event.text);
      case "toolCallDelta": {
        if (!event.arguments) return null;
        const index = event.callIndex ?? event.index ?? 0;
        let watch = this.calls.get(index);
        if (watch === undefined) {
          watch = new RunawayWatch();
          this.calls.set(index, watch);
        }
        return looped("arguments", watch, event.arguments);
      }
      default:
        return null;
    }
  }

  private all(): RunawayWatch[] {
    return [this.content, this.reasoning, ...this.calls.values()];
  }

  // the tokens streamed, estimated: what each watch holds counted, then
  // scaled to all it was fed, since a watch keeps only its latest tail
  tokens(): number {
    let total = 0;
    for (const watch of this.all()) {
      const held = watch.held();
      if (held === "") continue;
      total += Math.ceil((tokens(held) * watch.chars) / held.length);
    }
    return total;
  }
}

// A cut attempt sent no usage: its request, or the prompt a frame gave,
// and what it streamed count against the send's tokens as an estimate.
// One warning names where the loop was, never its text
export function cutLoop(
  log: Log,
  send: ActiveSend,
  round: RoundState,
  req: ChatRequest,
  watches: RoundWatches,
  loop: Loop,
): void {
  log.warn("round loop cut", {
    chat: send.sessionId,
    round: send.roundNo,
    channel: loop.channel,
    chars: loop.chars,
  });
  const prompt =
    round.usage?.promptTokens ?? requestTokens(send.policy.wire, req);
  send.budget.tokens += prompt + watches.tokens();
}

// a second loop fails the round, and its row keeps none of the looped
// bytes, so no later turn replays them
export function loopFailure(round: RoundState): Error {
  round.content = "";
  round.reasoning = "";
  round.reasoningDetails = [];
  round.calls = [];
  round.drafts.clear();
  round.finishReason = OUTPUT_LOOP_REASON;
  round.nativeFinish = null;
  return new Error(OUTPUT_LOOP);
}
