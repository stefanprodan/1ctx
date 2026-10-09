// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The anthropic recordings, and a fetch that answers the Messages
// address from a queue the test fills, recorded streams or refusals,
// and every other address as the app helper's fake does.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ANTHROPIC_CHAT, type FakeCall, fakeFetch } from "./app.ts";

export const anthropicFixture = (name: string) =>
  readFileSync(
    join(import.meta.dir, "..", "fixtures", "providers", "anthropic", name),
    "utf8",
  );

export type Answer = { status: number; body: string; open?: boolean };

// a recorded stream, or a recorded error body with its status
export const stream = (name: string): Answer => ({
  status: 200,
  body: anthropicFixture(name),
});
export const refusal = (name: string, status = 400): Answer => ({
  status,
  body: anthropicFixture(name),
});

// the frames a test writes itself, each `event:` then `data:`
export const frames = (...events: Record<string, unknown>[]): Answer => ({
  status: 200,
  body: events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join(""),
});

export function anthropicFetch(): {
  fetcher: typeof fetch;
  calls: FakeCall[];
  // the Messages requests' bodies, in order
  bodies: () => Record<string, any>[];
  queue: Answer[];
} {
  const fake = fakeFetch();
  const queue: Answer[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== ANTHROPIC_CHAT || queue.length === 0) {
      return fake.fetcher(input, init);
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init?.body === "string" ? init.body : null;
    fake.calls.push({ url, headers, body });
    const answer = queue.shift()!;
    // open: the connection stays up after the frames, as one may after
    // message_stop
    const content = answer.open
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(answer.body));
          },
        })
      : answer.body;
    return new Response(content, {
      status: answer.status,
      headers: {
        "content-type":
          answer.status === 200 ? "text/event-stream" : "application/json",
      },
    });
  }) as unknown as typeof fetch;
  return {
    fetcher,
    calls: fake.calls,
    bodies: () =>
      fake.calls
        .filter((call) => call.url === ANTHROPIC_CHAT)
        .map((call) => JSON.parse(call.body ?? "{}")),
    queue,
  };
}

export type Recorded = {
  // each block whole, as a reader of the raw frames builds it
  blocks: {
    type: string;
    id?: string;
    name?: string;
    text: string;
    thinking: string;
    signature: string;
    json: string;
  }[];
  stopReason: string | null;
  usage: Record<string, any>;
};

// what a recorded stream says, read straight from its frames, so a test
// compares the wire's events with the file and holds across recordings
export function recorded(name: string): Recorded {
  const out: Recorded = { blocks: [], stopReason: null, usage: {} };
  for (const line of anthropicFixture(name).split("\n")) {
    if (!line.startsWith("data:")) continue;
    const ev = JSON.parse(line.slice(5));
    if (ev.type === "content_block_start") {
      const b = ev.content_block;
      out.blocks[ev.index] = {
        type: b.type,
        ...(b.id ? { id: b.id } : {}),
        ...(b.name ? { name: b.name } : {}),
        text: "",
        thinking: "",
        signature: "",
        json: "",
      };
    }
    if (ev.type === "content_block_delta") {
      const b = out.blocks[ev.index]!;
      const d = ev.delta;
      if (d.type === "text_delta") b.text += d.text;
      if (d.type === "thinking_delta") b.thinking += d.thinking;
      if (d.type === "signature_delta") b.signature += d.signature;
      if (d.type === "input_json_delta") b.json += d.partial_json;
    }
    if (ev.type === "message_delta") {
      out.stopReason = ev.delta?.stop_reason ?? out.stopReason;
      out.usage = { ...out.usage, ...ev.usage };
    }
  }
  return out;
}
