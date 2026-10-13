// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { Clock } from "../../../src/server/lib/clock.ts";
import { azureEvents } from "../../../src/server/providers/azure-stream.ts";
import { streamChat } from "../../../src/server/providers/openai.ts";
import type {
  ChatEvent,
  Fetcher,
} from "../../../src/server/providers/types.ts";
import { rejection } from "../../helpers/async.ts";

const frame = (type: string, rest: object = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;

const COMPLETED = frame("response.completed", {
  response: {
    status: "completed",
    output: [],
    usage: { input_tokens: 1, output_tokens: 1 },
  },
});

const MESSAGE = { type: "message", phase: "final_answer" };
const REASONING = { type: "reasoning", summary: [], encrypted_content: "e" };

// lets in-memory work that was already due run
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// a silence limit the test rings by hand; a cancelled one is gone
function silences(): { clock: Clock; ring(): void } {
  const armed = new Set<() => void>();
  const clock: Clock = Object.assign(() => 0, {
    sleep: (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        armed.add(resolve);
        signal?.addEventListener("abort", () => armed.delete(resolve), {
          once: true,
        });
      }),
  });
  return {
    clock,
    ring() {
      for (const resolve of [...armed]) {
        armed.delete(resolve);
        resolve();
      }
    },
  };
}

// a reader that asked for more with nothing queued, once the in-memory
// work already due ran: it read every frame sent and waits on the next
function waiting(): {
  pull(): Promise<void>;
  reached: Promise<void>;
} {
  let reach = () => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return {
    reached,
    // never settles, so the stream asks no more
    async pull() {
      await flush();
      reach();
      await new Promise<never>(() => {});
    },
  };
}

// the frames before and after a pause, as Azure sends them: nothing
// while a reasoning item is open with no summary yet; the pause outlasts
// the silence limit
function pausing(
  before: string[],
  after: string[],
  limit: { ring(): void },
): Fetcher {
  return (async () => {
    const bytes = new TextEncoder();
    let paused = false;
    return new Response(
      new ReadableStream(
        {
          start(controller) {
            for (const f of before) controller.enqueue(bytes.encode(f));
          },
          async pull(controller) {
            if (paused) return;
            paused = true;
            await flush();
            limit.ring();
            await flush();
            try {
              for (const f of after) controller.enqueue(bytes.encode(f));
              controller.close();
            } catch {}
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as unknown as Fetcher;
}

async function run(
  fetcher: Fetcher,
  thinking: boolean,
  limit: { clock: Clock },
): Promise<ChatEvent[]> {
  const stream = azureEvents();
  const out: ChatEvent[] = [];
  for await (const event of streamChat(
    fetcher,
    "http://azure.test/openai/v1/responses",
    {},
    new AbortController().signal,
    {
      mapEvents: stream.map,
      ended: stream.ended,
      ...(thinking ? { thinking: stream.thinking } : {}),
      silenceClock: limit.clock,
    },
  )) {
    out.push(event);
  }
  return out;
}

describe("azure silence", () => {
  test("an open reasoning item lifts the silence limit", async () => {
    const limit = silences();
    const fetcher = pausing(
      [
        frame("response.created"),
        frame("response.output_item.added", {
          output_index: 0,
          item: REASONING,
        }),
      ],
      [
        frame("response.output_item.done", {
          output_index: 0,
          item: REASONING,
        }),
        frame("response.output_item.added", { output_index: 1, item: MESSAGE }),
        frame("response.output_text.delta", { output_index: 1, delta: "ok" }),
        frame("response.output_item.done", { output_index: 1, item: MESSAGE }),
        COMPLETED,
      ],
      limit,
    );
    const events = await run(fetcher, true, limit);
    expect(events.some((e) => e.kind === "error")).toBe(false);
    expect(events).toContainEqual({ kind: "content", text: "ok" });
  });

  test("silence with no reasoning open still ends the stream", async () => {
    const limit = silences();
    const fetcher = pausing(
      [
        frame("response.created"),
        frame("response.output_item.added", { output_index: 0, item: MESSAGE }),
        frame("response.output_text.delta", { output_index: 0, delta: "o" }),
      ],
      [frame("response.output_text.delta", { output_index: 0, delta: "k" })],
      limit,
    );
    const events = await run(fetcher, true, limit);
    expect(events).toContainEqual({
      kind: "error",
      message: "the provider was silent for 5 min",
    });
  });

  test("aborting the send ends a thinking read", async () => {
    const reader = waiting();
    const fetcher = (async (_url: string, init: RequestInit) =>
      new Response(
        new ReadableStream(
          {
            start(controller) {
              const bytes = new TextEncoder();
              controller.enqueue(bytes.encode(frame("response.created")));
              controller.enqueue(
                bytes.encode(
                  frame("response.output_item.added", {
                    output_index: 0,
                    item: REASONING,
                  }),
                ),
              );
              // never closes; only the send's signal ends it
              init.signal?.addEventListener("abort", () =>
                controller.error(new Error("aborted")),
              );
            },
            pull: reader.pull,
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream" } },
      )) as unknown as Fetcher;
    const stream = azureEvents();
    const abort = new AbortController();
    const limit = silences();
    const read = (async () => {
      for await (const _ of streamChat(
        fetcher,
        "http://azure.test/openai/v1/responses",
        {},
        abort.signal,
        {
          mapEvents: stream.map,
          ended: stream.ended,
          thinking: stream.thinking,
          silenceClock: limit.clock,
        },
      )) {
        // the events before the abort
      }
    })();
    await reader.reached;
    // a silence limit would ring here, but a thinking read has none
    limit.ring();
    abort.abort();
    await rejection(read);
    expect(stream.thinking()).toBe(true);
  });

  test("without the thinking option the limit holds", async () => {
    const limit = silences();
    const fetcher = pausing(
      [
        frame("response.created"),
        frame("response.output_item.added", {
          output_index: 0,
          item: REASONING,
        }),
      ],
      [COMPLETED],
      limit,
    );
    const events = await run(fetcher, false, limit);
    expect(events).toContainEqual({
      kind: "error",
      message: "the provider was silent for 5 min",
    });
  });
});
