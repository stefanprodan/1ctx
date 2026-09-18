// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The providers capability's chat, as the runner will call it: through
// the composed app, a saved provider row, the compose fetcher and the
// secrets port, with the recorded frames answering.

import { describe, expect, test } from "bun:test";
import { compose } from "../../src/server/compose.ts";
import { silent } from "../../src/server/lib/log.ts";
import type { ChatEvent } from "../../src/server/providers/index.ts";
import { isSecretName } from "../../src/shared/words.ts";
import { fakeFetch, PROVIDER_URL, VERSION } from "../helpers/app.ts";
import { memoryDb } from "../helpers/db.ts";

async function build(secrets: Record<string, string>) {
  const db = memoryDb();
  const fake = fakeFetch();
  const app = await compose({
    db,
    secret: (kind, name) => {
      if (!isSecretName(kind, name)) throw new Error("bad secret name");
      return secrets[name]?.trim() || null;
    },
    clock: () => 1_000_000,
    fetcher: fake.fetcher,
    log: () => silent,
    version: VERSION,
    secureCookie: false,
    trustProxy: false,
  });
  return { app, fake };
}

const request = {
  model: "org/model",
  messages: [{ role: "user" as const, content: "hello" }],
  thinking: false,
};

describe("the chat wire through the app", () => {
  test("streams the recorded reply with the key from the secrets port", async () => {
    const { app, fake } = await build({ "provider-local": "k-local" });
    const row = app.providers.create({
      name: "local",
      wire: "openai-compatible",
      baseUrl: PROVIDER_URL,
      keyName: "provider-local",
      now: 0,
    });
    const events: ChatEvent[] = [];
    for await (const event of app.chat(
      row.id,
      request,
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(events.at(-1)?.kind).toBe("usage");
    expect(events.some((e) => e.kind === "error")).toBe(false);
    // the plain wire's shape: no cost, the reasoning under its plain name
    const usage = events.at(-1) as Extract<ChatEvent, { kind: "usage" }>;
    expect(usage.usage.cost).toBeNull();
    expect(events.some((e) => e.kind === "reasoningDetail")).toBe(false);
    expect(events.some((e) => e.kind === "reasoning")).toBe(true);
    expect(events.some((e) => e.kind === "content")).toBe(true);
    const call = fake.calls.find((c) => c.url.endsWith("/chat/completions"));
    expect(call?.headers.authorization).toBe("Bearer k-local");
    expect(JSON.parse(call?.body ?? "{}").model).toBe("org/model");
  });

  test("a provider that is gone is a 404", async () => {
    const { app } = await build({});
    expect(() =>
      app.chat("nope", request, new AbortController().signal),
    ).toThrow("no such provider");
  });

  test("a tool round on the wire: null assistant content with calls, role tool, no tool_choice", async () => {
    const { app, fake } = await build({ "provider-local": "k" });
    const row = app.providers.create({
      name: "local",
      wire: "openai-compatible",
      baseUrl: PROVIDER_URL,
      keyName: "provider-local",
      now: 0,
    });
    const calls = [
      { id: "c1", name: "datetime", arguments: '{"timezone":"UTC"}' },
    ];
    const toolRequest = {
      model: "org/model",
      messages: [
        { role: "user" as const, content: "when" },
        // a work reply with no text goes back with null content and its
        // calls
        { role: "assistant" as const, content: "", toolCalls: calls },
        { role: "tool" as const, toolCallId: "c1", content: "2026-09-13" },
      ],
      thinking: false,
      tools: [{ name: "datetime", description: "d", parameters: {} }],
    };
    for await (const _ of app.chat(
      row.id,
      toolRequest,
      new AbortController().signal,
    )) {
      // drain
    }
    const call = fake.calls.find((c) => c.url.endsWith("/chat/completions"))!;
    const body = JSON.parse(call.body ?? "{}");
    // the schemas go as they are; a tool_choice would miss the cache
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBeUndefined();
    const assistant = body.messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    // null content when a work reply has calls but no text
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls).toEqual([
      {
        id: "c1",
        type: "function",
        function: { name: "datetime", arguments: '{"timezone":"UTC"}' },
      },
    ]);
    const tool = body.messages.find((m: { role: string }) => m.role === "tool");
    expect(tool).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "2026-09-13",
    });
  });
});
