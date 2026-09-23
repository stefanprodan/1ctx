// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One provider round: the request from the context, the stream, every
// delta to the writer, the finish and the usage kept on the round. The
// first tool call delta of a round marks the reply work at once, in its
// own transaction, so the row moves into the fold with its reasoning;
// the assembled calls land on round.calls when the stream ends. A
// provider failure is an error event and becomes a throw here, so the
// send ends through its one terminal transition. Once terminated the
// rest of the stream is dropped: the rows are already final.

import type { Message } from "../../shared/contracts/session.ts";
import type { Clock } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import {
  type ChatEvent,
  type ChatRequest,
  mergeReasoningDetail,
  requestTokens,
} from "../providers/index.ts";
import {
  type ContextLookups,
  history,
  request,
  summaryRequest,
  withExhausted,
} from "./context.ts";
import { RoundVisuals } from "./round-visuals.ts";
import type { ActiveSend, RoundState } from "./send.ts";
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
  log: Log;
};

export const STREAM_IDLE_MS = 120_000;
export const MAX_REPLY_BYTES = 1024 * 1024;

type TimedNext =
  | { kind: "next"; result: IteratorResult<ChatEvent> }
  | { kind: "idle" };

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

function sleep(clock: Clock, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    promise:
      clock.sleep?.(ms) ??
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

// idleMs is null before the first event: a local server says nothing
// while it reads a long prompt, minutes for a cold 64k tokens, so only
// the send's deadline, Stop and shutdown bound that wait
async function nextEvent(
  iterator: AsyncIterator<ChatEvent>,
  clock: Clock,
  visuals: RoundVisuals | null,
  idleMs: number | null,
): Promise<TimedNext> {
  const read = iterator.next().then((result) => ({
    kind: "next" as const,
    result,
  }));
  const idle =
    idleMs === null
      ? { promise: new Promise<void>(() => {}), cancel: () => {} }
      : sleep(clock, idleMs);
  const quiet = idle.promise.then(() => ({ kind: "idle" as const }));
  try {
    while (true) {
      const delay = visuals?.delay(clock()) ?? null;
      if (delay === null) return await Promise.race([read, quiet]);
      const paint = sleep(clock, delay);
      try {
        const next = await Promise.race([
          read,
          quiet,
          paint.promise.then(() => ({ kind: "visual" as const })),
        ]);
        if (next.kind !== "visual") return next;
        visuals?.flush();
      } finally {
        paint.cancel();
      }
    }
  } finally {
    idle.cancel();
  }
}

export function buildRequest(
  send: ActiveSend,
  rows: Message[],
  lookups: ContextLookups,
  now: number,
): ChatRequest {
  const messages = history(rows, send.policy, lookups, now, send.mcpNote);
  if (send.summarizing) {
    return summaryRequest(send.policy, send.sessionId, messages, send.used);
  }
  const req = request(
    send.policy,
    send.sessionId,
    // the answer round appends the exhausted line to a request-local
    // copy, never the stored rows
    send.answering ? withExhausted(messages, send.answering) : messages,
  );
  // The answer round keeps the schemas untouched and asks in words: a
  // tool_choice changes the prompt a server renders and misses its
  // cache (mlx-serve: 138 s against 1.4 s for 64k tokens). A call anyway
  // is asked again with no schemas, with nothing left to call.
  if (send.bare) {
    const { tools: _tools, ...bare } = req;
    return bare;
  }
  return req;
}

export async function runRound(
  deps: RoundDeps,
  send: ActiveSend,
  rows: Message[],
  options: { request?: ChatRequest; signal?: AbortSignal } = {},
): Promise<void> {
  const round = send.round;
  if (round === null) return;
  const signal = options.signal ?? send.controller.signal;
  const req =
    options.request ?? buildRequest(send, rows, deps.lookups, deps.clock());
  const open = () =>
    deps.chat(send.policy.providerId, req, signal)[Symbol.asyncIterator]();
  let iterator = open();
  let retried = false;
  const visuals =
    send.phase === "provider" &&
    send.kind !== "compact" &&
    !send.summarizing &&
    !send.answering &&
    send.policy.offered.tools.some((tool) => tool.name === "visualize")
      ? new RoundVisuals(send, round, deps.writer, signal)
      : null;
  let replyBytes = bytes(round.content) + bytes(round.reasoning);
  let started = false;
  while (true) {
    const next = await nextEvent(
      iterator,
      deps.clock,
      visuals,
      started ? STREAM_IDLE_MS : null,
    );
    if (next.kind === "idle") throw new Error("the provider went quiet");
    if (next.result.done) break;
    const event = next.result.value;
    if (signal.aborted) return;
    if (!started && !retried && event.kind === "error" && event.unanswered) {
      retried = true;
      deps.log.warn("round retried", {
        chat: send.sessionId,
        round: send.roundNo,
        ...errorFields(new Error(event.message), false),
      });
      iterator = open();
      continue;
    }
    started = true;
    switch (event.kind) {
      case "reasoning":
        if (send.summarizing) break;
        replyBytes += bytes(event.text);
        if (replyBytes > MAX_REPLY_BYTES) {
          throw new Error("the reply exceeded 1 MB");
        }
        deps.writer.delta(send, event);
        break;
      case "content": {
        replyBytes += bytes(event.text);
        if (replyBytes > MAX_REPLY_BYTES) {
          throw new Error("the reply exceeded 1 MB");
        }
        deps.writer.delta(send, event);
        break;
      }
      case "reasoningDetail":
        if (send.summarizing) break;
        round.reasoningDetails = mergeReasoningDetail(
          round.reasoningDetails,
          event.item,
        );
        break;
      case "toolCallDelta":
        replyBytes += bytes(event.arguments ?? "");
        if (replyBytes > MAX_REPLY_BYTES) {
          throw new Error("the reply exceeded 1 MB");
        }
        if (send.summarizing) break;
        // the server's earliest certain knowledge that this is a work
        // round: move the row into the fold once, guarded by the round
        markWork(deps, send, round);
        visuals?.push(event, deps.clock());
        break;
      case "toolCalls":
        if (!send.summarizing) round.calls = event.calls;
        break;
      case "finish":
        round.finishReason = event.details
          ? `${event.reason}/${event.details}`
          : event.reason;
        break;
      case "usage": {
        const previous = round.usage;
        round.usage = event.usage;
        send.promptTokens +=
          event.usage.promptTokens - (previous?.promptTokens ?? 0);
        send.completionTokens +=
          event.usage.completionTokens - (previous?.completionTokens ?? 0);
        break;
      }
      case "error":
        throw new Error(event.message);
      default:
        break;
    }
  }
  if (!signal.aborted && round.finishReason === null) {
    throw new Error("the stream ended early");
  }
  visuals?.flush();
  round.tokens =
    round.usage === null
      ? requestTokens(req)
      : round.usage.promptTokens + round.usage.completionTokens;
}

// the first tool call delta of a round marks it work, once; the round
// remembers, so a later delta writes nothing
function markWork(deps: RoundDeps, send: ActiveSend, round: RoundState): void {
  if (round.slotMarked) return;
  round.slotMarked = true;
  // a call delta is the first token when no text came before it
  if (round.ttftMs === null) round.ttftMs = deps.clock() - round.startedAt;
  deps.writer.markRoundWork(send);
}
