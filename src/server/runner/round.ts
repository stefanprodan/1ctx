// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One provider round: the request from the context, the stream, every
// delta to the writer, the finish and the usage kept on the round. A
// provider failure is an error event on the stream and becomes a throw
// here, so the send ends through its one terminal transition. Once the
// send is terminated the rest of the stream is dropped: the rows are
// already final.

import type { Message } from "../../shared/contracts/session.ts";
import type { Clock } from "../lib/clock.ts";
import {
  type ChatEvent,
  type ChatRequest,
  mergeReasoningDetail,
} from "../providers/index.ts";
import { type ContextLookups, history, request } from "./context.ts";
import type { ActiveSend } from "./send.ts";
import type { Writer } from "./writer.ts";

export type RoundDeps = {
  chat(
    providerId: string,
    req: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatEvent>;
  writer: Writer;
  lookups: ContextLookups;
  clock: Clock;
};

export const STREAM_IDLE_MS = 120_000;
export const MAX_REPLY_BYTES = 1024 * 1024;

type TimedNext =
  | { kind: "next"; result: IteratorResult<ChatEvent> }
  | { kind: "idle" };

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

function nextEvent(
  iterator: AsyncIterator<ChatEvent>,
  clock: Clock,
): Promise<TimedNext> {
  if (clock.sleep) {
    return Promise.race([
      iterator.next().then((result) => ({ kind: "next" as const, result })),
      clock.sleep(STREAM_IDLE_MS).then(() => ({ kind: "idle" as const })),
    ]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ kind: "idle" }), STREAM_IDLE_MS);
    iterator.next().then(
      (result) => {
        clearTimeout(timer);
        resolve({ kind: "next", result });
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function buildRequest(
  send: ActiveSend,
  rows: Message[],
  lookups: ContextLookups,
  now: number,
): ChatRequest {
  return request(
    send.policy,
    send.sessionId,
    history(rows, send.policy, lookups, now),
  );
}

export async function runRound(
  deps: RoundDeps,
  send: ActiveSend,
  rows: Message[],
): Promise<void> {
  const round = send.round;
  const req = buildRequest(send, rows, deps.lookups, deps.clock());
  const events = deps.chat(send.policy.providerId, req, send.controller.signal);
  const iterator = events[Symbol.asyncIterator]();
  let replyBytes = bytes(round.content) + bytes(round.reasoning);
  while (true) {
    const next = await nextEvent(iterator, deps.clock);
    if (next.kind === "idle") throw new Error("the provider went quiet");
    if (next.result.done) break;
    const event = next.result.value;
    if (send.terminal !== null) return;
    switch (event.kind) {
      case "reasoning":
      case "content": {
        replyBytes += bytes(event.text);
        if (replyBytes > MAX_REPLY_BYTES) {
          throw new Error("the reply exceeded 1 MB");
        }
        deps.writer.delta(send, event);
        break;
      }
      case "reasoningDetail":
        round.reasoningDetails = mergeReasoningDetail(
          round.reasoningDetails,
          event.item,
        );
        break;
      case "finish":
        round.finishReason = event.details
          ? `${event.reason}/${event.details}`
          : event.reason;
        break;
      case "usage":
        round.usage = event.usage;
        break;
      case "error":
        throw new Error(event.message);
      default:
        // tool calls wait for the tools slice; a model that calls one
        // anyway ends the round on its finish reason
        break;
    }
  }
  if (send.terminal === null && round.finishReason === null) {
    throw new Error("the stream ended early");
  }
}
