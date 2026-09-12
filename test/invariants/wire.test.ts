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
import { fakeFetch, PROVIDER_URL, VERSION } from "../helpers/app.ts";
import { memoryDb } from "../helpers/db.ts";

async function build(secrets: Record<string, string>) {
  const db = memoryDb();
  const fake = fakeFetch();
  const app = await compose({
    db,
    secret: (name) => secrets[name] ?? null,
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
    const { app, fake } = await build({ local: "k-local" });
    const row = app.providers.create({
      name: "local",
      wire: "openai-compatible",
      baseUrl: PROVIDER_URL,
      keyName: "local",
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
});
