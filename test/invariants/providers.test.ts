// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A provider is added and deleted, never changed; its key is a file
// whose presence the list shows and whose value never leaves; the
// catalog is searched on the server and a dead provider is a 502.

import { describe, expect, test } from "bun:test";
import { BadRequest } from "../../src/server/lib/errors.ts";
import { modelPrice } from "../../src/server/providers/index.ts";
import {
  parseBaseUrl,
  parseCatalogQuery,
  parseKeyName,
  parseModelQuery,
  parseProvider,
} from "../../src/server/providers/parse.ts";
import secretNames from "../fixtures/secrets/names.json";
import {
  ANTHROPIC_MODELS,
  ANTHROPIC_URL,
  AZURE_DEPLOYMENTS,
  AZURE_URL,
  GEMINI_URL,
  PROVIDER_URL,
  testApp,
} from "../helpers/app.ts";
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
  keyName: "provider-router",
};

describe("parseProvider", () => {
  test("keys must have the provider kind and a 1 to 48 character body", () => {
    expect(parseKeyName(null)).toBeNull();
    for (const body of secretNames.validBodies) {
      expect(parseKeyName(`provider-${body}`)).toBe(`provider-${body}`);
    }
    for (const name of [
      ...secretNames.invalidBodies.map((body) => `provider-${body}`),
      ...secretNames.wrongNames,
      "user-admin",
      "search-exa",
      "mcp-github",
      undefined,
      1,
      {},
    ]) {
      expect(() => parseKeyName(name)).toThrow(BadRequest);
    }
  });

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
      { ...router, wire: "claude" },
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
    const q = (query: string) =>
      parseCatalogQuery(new URL(`http://x/${query}`)).q;
    expect(q("?q=%20deep%20")).toBe("deep");
    expect(q("")).toBe("");
    expect(() => q(`?q=${"a".repeat(101)}`)).toThrow(BadRequest);
    expect(parseBaseUrl("https://models.test")).toBe("https://models.test");
  });

  test("the query names are known and given once", () => {
    const catalog = (query: string) =>
      parseCatalogQuery(new URL(`http://x/${query}`));
    const model = (query: string) =>
      parseModelQuery(new URL(`http://x/${query}`));
    expect(catalog("?q=deep&kind=decisions")).toEqual({
      q: "deep",
      kind: "decisions",
    });
    expect(model("?model=a/b")).toBe("a/b");
    for (const [parse, query, message] of [
      [catalog, "?q=deep&page=2", "unknown parameter page"],
      [catalog, "?q=a&q=b", "q must appear once"],
      [catalog, "?kind=chat&kind=chat", "kind must appear once"],
      [model, "?model=a/b&q=x", "unknown parameter q"],
      [model, "?model=a/b&model=c/d", "model must appear once"],
    ] as const) {
      expect(() => parse(query), query).toThrow(message);
    }
  });
});

describe("the providers", () => {
  test("are listed with whether the key file is there, never its value", async () => {
    const { app, client } = await admin({
      secrets: {
        "provider-router": "sk-secret",
        "provider-empty": "",
        "provider-unused": "unused-secret",
        "mcp-github": "mcp-secret",
        "search-exa": "search-secret",
        "user-other": "password",
        "provider-": "invalid",
        "provider-Bad": "invalid",
        [`provider-${"a".repeat(49)}`]: "invalid",
        "unknown-token": "invalid",
        bare: "invalid",
      },
    });
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
      body: { ...router, name: "other", keyName: "provider-other" },
    });
    expect(missing.status).toBe(201);
    const res = await client.call("GET", "/api/providers");
    const text = await res.text();
    expect(text).not.toContain("sk-secret");
    const { providers, keys } = JSON.parse(text);
    expect(keys).toEqual([
      "provider-empty",
      "provider-router",
      "provider-unused",
    ]);
    expect(text).not.toContain("unused-secret");
    expect(text).not.toContain("mcp-secret");
    expect(text).not.toContain("search-secret");
    expect(text).not.toContain("hunter2-test");
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
    expect(providers[2]).toMatchObject({
      keyName: "provider-other",
      hasKey: false,
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
  test("creates a Gemini provider and searches its native catalog with the key header", async () => {
    const { app, client } = await admin({
      secrets: { "provider-gemini": "gemini-test-key" },
    });
    try {
      const created = await client.call("POST", "/api/providers", {
        body: {
          name: "gemini",
          wire: "gemini",
          baseUrl: GEMINI_URL,
          keyName: "provider-gemini",
        },
      });
      expect(created.status).toBe(201);
      const { provider } = await created.json();
      expect(provider).toMatchObject({ wire: "gemini", hasKey: true });
      const result = await client.call(
        "GET",
        `/api/providers/${provider.id}/catalog?q=flash`,
      );
      expect(result.status).toBe(200);
      const { matches } = await result.json();
      expect(matches.map((model: { id: string }) => model.id)).toEqual([
        "gemini-3.8-flash",
        "gemini-2.5-flash",
      ]);
      expect(matches[0]).toEqual({
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        contextLength: 1048576,
        // the window is the catalog's own; the prices are models.dev's
        promptPrice: modelPrice("google", "gemini-3.8-flash")!.input,
        completionPrice: modelPrice("google", "gemini-3.8-flash")!.output,
        tools: true,
        reasoning: true,
        thinkingRequired: false,
        reasoningKnown: true,
        described: true,
        listedAs: "gemini-3.8-flash",
      });
      const agent = await client.call("POST", "/api/agents", {
        body: {
          name: "gemini-agent",
          providerId: provider.id,
          model: matches[0].id,
          thinking: "on",
          effort: "high",
          servers: [],
          mcpMode: "auto",
        },
      });
      expect(agent.status).toBe(201);
      expect((await agent.json()).agent).toMatchObject({
        model: matches[0],
        thinking: "on",
        effort: "high",
      });
      expect(app.fetched).toEqual([
        {
          url: `${GEMINI_URL}/models?pageSize=1000`,
          headers: {
            "user-agent": "1ctx/v0.0.0-test",
            "x-goog-api-key": "gemini-test-key",
          },
          body: null,
        },
      ]);
    } finally {
      await app.shutdown();
      app.db.close();
    }
  });

  test("an azure provider takes only a resource's v1 address, and its catalog is the deployments", async () => {
    const { app, client } = await admin({
      secrets: { "provider-azure": "azure-test-key" },
    });
    try {
      for (const baseUrl of [
        "http://foundry.test/openai/v1",
        "https://foundry.test/openai",
        "https://foundry.test/openai/v1/responses",
      ]) {
        const refused = await client.call("POST", "/api/providers", {
          body: { name: "azure", wire: "azure", baseUrl, keyName: null },
        });
        expect(refused.status).toBe(400);
        expect((await refused.json()).error).toStartWith(
          "baseUrl must be https://<resource>",
        );
      }
      const created = await client.call("POST", "/api/providers", {
        body: {
          name: "azure",
          wire: "azure",
          baseUrl: `${AZURE_URL}/`,
          keyName: "provider-azure",
        },
      });
      expect(created.status).toBe(201);
      const { provider } = await created.json();
      expect(provider).toMatchObject({ wire: "azure", baseUrl: AZURE_URL });
      const result = await client.call(
        "GET",
        `/api/providers/${provider.id}/catalog?q=gpt`,
      );
      expect(result.status).toBe(200);
      const { matches } = await result.json();
      expect(matches.map((model: { id: string }) => model.id)).toEqual([
        "gpt-6-luna",
        "gpt-6.1-sol",
      ]);
      // undescribed, so the agent states its window to take tools
      const agent = await client.call("POST", "/api/agents", {
        body: {
          name: "luna",
          providerId: provider.id,
          model: "gpt-6-luna",
          thinking: "on",
          effort: "xhigh",
          servers: [],
          mcpMode: "auto",
          contextLength: 400_000,
          tools: true,
        },
      });
      expect(agent.status).toBe(201);
      expect(app.fetched).toEqual([
        {
          url: AZURE_DEPLOYMENTS,
          headers: {
            "user-agent": "1ctx/v0.0.0-test",
            "api-key": "azure-test-key",
          },
          body: null,
        },
      ]);
    } finally {
      await app.shutdown();
      app.db.close();
    }
  });

  test("an anthropic provider's catalog is described, read with the key and the version", async () => {
    const { app, client } = await admin({
      secrets: { "provider-anthropic": "sk-ant-test" },
    });
    try {
      const created = await client.call("POST", "/api/providers", {
        body: {
          name: "anthropic",
          wire: "anthropic",
          baseUrl: ANTHROPIC_URL,
          keyName: "provider-anthropic",
        },
      });
      expect(created.status).toBe(201);
      const { provider } = await created.json();
      const result = await client.call(
        "GET",
        `/api/providers/${provider.id}/catalog?q=haiku`,
      );
      expect(result.status).toBe(200);
      const { matches } = await result.json();
      expect(matches.map((model: { id: string }) => model.id)).toEqual([
        "claude-haiku-5-5",
        "claude-haiku-4-5-20251001",
      ]);
      // described: no window is stated, and the cap is kept
      const agent = await client.call("POST", "/api/agents", {
        body: {
          name: "haiku",
          providerId: provider.id,
          model: "claude-haiku-5-5",
          thinking: "off",
          effort: null,
          servers: [],
          mcpMode: "auto",
        },
      });
      expect(agent.status).toBe(201);
      expect((await agent.json()).agent).toMatchObject({
        thinking: "off",
        model: { described: true, outputLimit: 128_000 },
      });
      expect(app.fetched).toEqual([
        {
          url: ANTHROPIC_MODELS,
          headers: {
            "user-agent": "1ctx/v0.0.0-test",
            "x-api-key": "sk-ant-test",
            "anthropic-version": "2023-06-01",
          },
          body: null,
        },
      ]);
    } finally {
      await app.shutdown();
      app.db.close();
    }
  });

  test("answers the matches for what was typed, from one fetch with the key", async () => {
    const { app, client } = await admin({
      secrets: { "provider-router": "sk-router" },
    });
    const { provider } = await (
      await client.call("POST", "/api/providers", { body: router })
    ).json();
    const res = await client.call(
      "GET",
      `/api/providers/${provider.id}/catalog?q=opus-5`,
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
      thinkingRequired: expect.any(Boolean),
      reasoningKnown: true,
      described: true,
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
