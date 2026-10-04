// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { azureEvents } from "../../../src/server/providers/azure-stream.ts";
import { streamChat } from "../../../src/server/providers/openai.ts";
import type {
  ChatEvent,
  Fetcher,
} from "../../../src/server/providers/types.ts";

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

// the frames before and after a pause, as Azure sends them: nothing
// while a reasoning item is open with no summary yet
function pausing(before: string[], after: string[], pauseMs: number): Fetcher {
  return (async () =>
    new Response(
      new ReadableStream({
        async start(controller) {
          const bytes = new TextEncoder();
          for (const f of before) controller.enqueue(bytes.encode(f));
          await Bun.sleep(pauseMs);
          for (const f of after) controller.enqueue(bytes.encode(f));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )) as unknown as Fetcher;
}

async function run(fetcher: Fetcher, thinking: boolean): Promise<ChatEvent[]> {
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
      silenceMs: 50,
    },
  )) {
    out.push(event);
  }
  return out;
}

describe("azure silence", () => {
  test("an open reasoning item lifts the silence limit", async () => {
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
      200,
    );
    const events = await run(fetcher, true);
    expect(events.some((e) => e.kind === "error")).toBe(false);
    expect(events).toContainEqual({ kind: "content", text: "ok" });
  });

  test("silence with no reasoning open still ends the stream", async () => {
    const fetcher = pausing(
      [
        frame("response.created"),
        frame("response.output_item.added", { output_index: 0, item: MESSAGE }),
        frame("response.output_text.delta", { output_index: 0, delta: "o" }),
      ],
      [frame("response.output_text.delta", { output_index: 0, delta: "k" })],
      200,
    );
    const events = await run(fetcher, true);
    expect(events).toContainEqual({
      kind: "error",
      message: "the provider was silent for 5 min",
    });
  });

  test("aborting the send ends a thinking read", async () => {
    const fetcher = (async (_url: string, init: RequestInit) =>
      new Response(
        new ReadableStream({
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
        }),
        { headers: { "content-type": "text/event-stream" } },
      )) as unknown as Fetcher;
    const stream = azureEvents();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 150);
    const started = Date.now();
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
          silenceMs: 50,
        },
      )) {
        // the events before the abort
      }
    })();
    await expect(read).rejects.toThrow();
    expect(stream.thinking()).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("without the thinking option the limit holds", async () => {
    const fetcher = pausing(
      [
        frame("response.created"),
        frame("response.output_item.added", {
          output_index: 0,
          item: REASONING,
        }),
      ],
      [COMPLETED],
      200,
    );
    const events = await run(fetcher, false);
    expect(events).toContainEqual({
      kind: "error",
      message: "the provider was silent for 5 min",
    });
  });
});
