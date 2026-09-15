// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A provider is added and deleted, never changed; its key is a file
// whose presence the list shows and whose value never leaves; the
// catalog is searched on the server and a dead provider is a 502.

import { describe, expect, test } from "bun:test";
import { BadRequest } from "../../src/server/lib/errors.ts";
import {
  parseBaseUrl,
  parseProvider,
  parseQuery,
} from "../../src/server/providers/parse.ts";
import { PROVIDER_URL, testApp } from "../helpers/app.ts";
import { refuses } from "../helpers/refuses.ts";

const admin = async (options?: Parameters<typeof testApp>[0]) => {
  const app = await testApp(options);
  const client = app.client();
  await client.login("admin", "hunter2-test");
  return { app, client };
};

const router = {
  name: "router",
  wire: "openrouter" as const,
  baseUrl: PROVIDER_URL,
  keyName: "router",
};

describe("parseProvider", () => {
  test("accepts a provider and trims the slash off its address", () => {
    expect(parseProvider({ ...router, baseUrl: `${PROVIDER_URL}/` })).toEqual(
      router,
    );
    expect(parseProvider({ ...router, keyName: null }).keyName).toBeNull();
  });

  test("takes the shared name rule, underscores and 80 characters", () => {
    expect(parseProvider({ ...router, name: "mlx_serve" }).name).toBe(
      "mlx_serve",
    );
    expect(
      parseProvider({ ...router, name: "a".repeat(80) }).name,
    ).toHaveLength(80);
  });

  refuses(
    [
      null,
      {},
      { ...router, extra: 1 },
      { ...router, name: "R" },
      { ...router, name: "a" },
      { ...router, name: "mlx.serve" },
      { ...router, name: "a".repeat(81) },
      { ...router, wire: "anthropic" },
      { ...router, wire: "openai" },
      { ...router, baseUrl: "models.test/v1" },
      { ...router, baseUrl: "ftp://models.test/v1" },
      { ...router, baseUrl: "http://models.test/v1?x=1" },
      { ...router, baseUrl: "http://user@models.test/v1" },
      { ...router, baseUrl: `http://${"a".repeat(300)}/v1` },
      { ...router, keyName: "" },
      { ...router, keyName: "Router" },
      { ...router, keyName: "../admin" },
      { ...router, keyName: "admin" },
      { ...router, baseUrl: "http://:secret@models.test/v1" },
      { ...router, keyName: "sk-".padEnd(65, "a") },
    ],
    parseProvider,
  );

  test("the query is trimmed and capped", () => {
    expect(parseQuery(new URL("http://x/?q=%20deep%20"))).toBe("deep");
    expect(parseQuery(new URL("http://x/"))).toBe("");
    expect(() => parseQuery(new URL(`http://x/?q=${"a".repeat(101)}`))).toThrow(
      BadRequest,
    );
    expect(parseBaseUrl("https://models.test")).toBe("https://models.test");
  });
});

describe("the providers", () => {
  test("are listed with whether the key file is there, never its value", async () => {
    const { app, client } = await admin({ secrets: { router: "sk-secret" } });
    const created = await client.call("POST", "/api/providers", {
      body: router,
    });
    expect(created.status).toBe(201);
    app.now.value += 1000;
    const local = await client.call("POST", "/api/providers", {
      body: {
        name: "local",
        wire: "openai-compatible",
        baseUrl: "http://local.test:8000/v1",
        keyName: null,
      },
    });
    expect(local.status).toBe(201);
    app.now.value += 1000;
    const missing = await client.call("POST", "/api/providers", {
      body: { ...router, name: "other", keyName: "other" },
    });
    expect(missing.status).toBe(201);
    const res = await client.call("GET", "/api/providers");
    const text = await res.text();
    expect(text).not.toContain("sk-secret");
    const { providers } = JSON.parse(text);
    expect(
      providers.map((p: { name: string; hasKey: boolean }) => [
        p.name,
        p.hasKey,
      ]),
    ).toEqual([
      ["router", true],
      ["local", false],
      ["other", false],
    ]);
    expect(providers[0]).toEqual({
      id: expect.any(String),
      ...router,
      hasKey: true,
      createdAt: expect.any(Number),
    });
  });

  test("a name is taken once", async () => {
    const { client } = await admin();
    expect(
      (await client.call("POST", "/api/providers", { body: router })).status,
    ).toBe(201);
    const again = await client.call("POST", "/api/providers", { body: router });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: "a provider named router exists",
    });
  });

  test("one goes unless an agent runs on it", async () => {
    const { app, client } = await admin();
    const { provider } = await (
      await client.call("POST", "/api/providers", { body: router })
    ).json();
    const agent = await client.call("POST", "/api/agents", {
      body: {
        name: "coder",
        providerId: provider.id,
        model: "deepseek/deepseek-chat",
        thinking: null,
        effort: null,
        servers: [],
        mcpMode: "auto",
      },
    });
    expect(agent.status).toBe(201);
    const held = await client.call("DELETE", `/api/providers/${provider.id}`);
    expect(held.status).toBe(409);
    const { agent: row } = await agent.json();
    expect((await client.call("DELETE", `/api/agents/${row.id}`)).status).toBe(
      200,
    );
    expect(
      (await client.call("DELETE", `/api/providers/${provider.id}`)).status,
    ).toBe(200);
    expect(app.providers.list()).toEqual([]);
    expect(
      (await client.call("DELETE", `/api/providers/${provider.id}`)).status,
    ).toBe(404);
  });
});

describe("GET /api/providers/:id/catalog", () => {
  test("answers the matches for what was typed, from one fetch with the key", async () => {
    const { app, client } = await admin({ secrets: { router: "sk-router" } });
    const { provider } = await (
      await client.call("POST", "/api/providers", { body: router })
    ).json();
    const res = await client.call(
      "GET",
      `/api/providers/${provider.id}/catalog?q=opus%205`,
    );
    expect(res.status).toBe(200);
    const { matches } = await res.json();
    expect(matches.map((m: { id: string }) => m.id)).toEqual([
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-5:batch",
    ]);
    expect(matches[0]).toEqual({
      id: "anthropic/claude-opus-5",
      name: expect.any(String),
      contextLength: expect.any(Number),
      promptPrice: expect.any(Number),
      completionPrice: expect.any(Number),
      tools: expect.any(Boolean),
      reasoning: expect.any(Boolean),
    });
    await client.call("GET", `/api/providers/${provider.id}/catalog?q=chat`);
    expect(app.fetched.length).toBe(1);
    expect(app.fetched[0].headers.authorization).toBe("Bearer sk-router");
    const empty = await client.call(
      "GET",
      `/api/providers/${provider.id}/catalog`,
    );
    expect(await empty.json()).toEqual({ matches: [] });
  });

  test("a provider that does not answer is a 502", async () => {
    const { client } = await admin();
    const { provider } = await (
      await client.call("POST", "/api/providers", {
        body: { ...router, baseUrl: "http://down.test/v1" },
      })
    ).json();
    const res = await client.call(
      "GET",
      `/api/providers/${provider.id}/catalog?q=x`,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "the provider did not answer: unable to connect",
    });
  });
});
