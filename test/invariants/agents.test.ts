// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent names a provider and a model the provider's catalog lists;
// what the catalog said about the model rides on the row.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgent } from "../../src/server/agents/parse.ts";
import {
  Catalogs,
  type ProviderRow,
} from "../../src/server/providers/index.ts";
import { fakeFetch, NIM_URL, PROVIDER_URL, testApp } from "../helpers/app.ts";
import { settleRun } from "../helpers/automations.ts";
import { chatApp, startChat } from "../helpers/chat.ts";
import { refuses } from "../helpers/refuses.ts";

const setup = async (fetcher?: typeof fetch) => {
  const app = await testApp(fetcher === undefined ? {} : { fetcher });
  const client = app.client();
  await client.login("admin", "hunter2-test");
  const { provider } = await (
    await client.call("POST", "/api/providers", {
      body: {
        name: "router",
        wire: "openrouter",
        baseUrl: PROVIDER_URL,
        keyName: null,
      },
    })
  ).json();
  return { app, client, provider };
};

const flash = {
  id: "deepseek/deepseek-v4.1-flash",
  name: "DeepSeek: DeepSeek V4.1 Flash",
  contextLength: 1048576,
  promptPrice: 0.15,
  completionPrice: 0.6,
  tools: true,
  reasoning: true,
  thinkingRequired: false,
  reasoningKnown: true,
  described: true,
};

const defaults = {
  thinking: null,
  effort: null,
  servers: [],
  mcpMode: "auto",
} as const;

test("project agents report the admin's capabilities through the tools port", async () => {
  const chat = await chatApp();
  try {
    for (const mode of ["all", "off", "listed"] as const) {
      const changed = await chat.admin.call("PATCH", "/api/tools/web", {
        body: { mode, domains: ["docs.test"] },
      });
      expect(changed.status).toBe(200);
      const response = await chat.member.call(
        "GET",
        `/api/projects/${chat.projectId}/agents`,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.capabilities).toEqual(
        mode === "off"
          ? ["visualize", "automations", "knowledge", "memory"]
          : ["web", "visualize", "automations", "knowledge", "memory"],
      );
      expect(body.agents.map((agent: { id: string }) => agent.id)).toContain(
        chat.agentId,
      );
    }
  } finally {
    await chat.app.shutdown();
  }
});

describe("parseAgent", () => {
  refuses(
    [
      null,
      {},
      { name: "coder", providerId: "p", model: "m", extra: 1 },
      { name: "C", providerId: "p", model: "m" },
      { name: "code.r", providerId: "p", model: "m" },
      { name: "a".repeat(81), providerId: "p", model: "m" },
      { name: "coder", providerId: "", model: "m" },
      { name: "coder", providerId: 1, model: "m" },
      { name: "coder", providerId: "p", model: "" },
      { name: "coder", providerId: "p", model: "m".repeat(201) },
      { name: "coder", providerId: "p", model: "m", prompt: 1 },
      { name: "coder", providerId: "p", model: "m", avatar: "cat" },
      {
        name: "coder",
        providerId: "p",
        model: "m",
        prompt: "p".repeat(16_001),
      },
    ],
    parseAgent,
  );

  test("takes the shared name rule, underscores and 80 characters", () => {
    const body = { ...defaults, providerId: "p", model: "m" };
    expect(parseAgent({ ...body, name: "code_r" }).name).toBe("code_r");
    expect(parseAgent({ ...body, name: "a".repeat(80) }).name).toHaveLength(80);
  });

  test("accepts null, on and off thinking and rejects bad values", () => {
    const body = { ...defaults, name: "coder", providerId: "p", model: "m" };
    expect(parseAgent(body)).toMatchObject(defaults);
    expect(parseAgent({ ...body, thinking: "on" }).thinking).toBe("on");
    expect(parseAgent({ ...body, thinking: "off" }).thinking).toBe("off");
    expect(() => parseAgent({ ...body, thinking: "maybe" })).toThrow();
    expect(() => parseAgent({ ...body, effort: 1 })).toThrow();
  });

  test("parses MCP servers and mode and refuses bad assignments", () => {
    const body = {
      ...defaults,
      name: "coder",
      providerId: "p",
      model: "m",
      servers: [{ serverId: "s1", read: true, write: false }],
      mcpMode: "catalog",
    } as const;
    expect(parseAgent(body)).toMatchObject({
      servers: [{ serverId: "s1", read: true, write: false }],
      mcpMode: "catalog",
    });
    expect(() =>
      parseAgent({
        ...body,
        servers: [{ serverId: "s1", read: false, write: false }],
      }),
    ).toThrow("a server needs read");
    expect(() =>
      parseAgent({
        ...body,
        servers: [{ serverId: "s1", read: false, write: true }],
      }),
    ).toThrow("a server needs read");
    expect(() =>
      parseAgent({ ...body, servers: [...body.servers, ...body.servers] }),
    ).toThrow("serverId must not repeat");
    expect(() => parseAgent({ ...body, mcpMode: "sometimes" })).toThrow(
      "mcpMode must be all, catalog or auto",
    );
    expect(() =>
      parseAgent({
        name: "coder",
        providerId: "p",
        model: "m",
        thinking: null,
        effort: null,
        mcpMode: "auto",
      }),
    ).toThrow("servers must be an array");
    expect(() =>
      parseAgent({
        name: "coder",
        providerId: "p",
        model: "m",
        thinking: null,
        effort: null,
        servers: [],
      }),
    ).toThrow("mcpMode must be all, catalog or auto");
    expect(() =>
      parseAgent({
        ...body,
        servers: Array.from({ length: 51 }, (_, index) => ({
          serverId: `s${index}`,
          read: true,
          write: false,
        })),
      }),
    ).toThrow("an agent may have at most 50 MCP servers");
  });
});

describe("the agents", () => {
  test("the prompt is optional and trimmed, the avatar a bot by default", () => {
    const bare = parseAgent({
      ...defaults,
      name: "coder",
      providerId: "p",
      model: "m",
    });
    expect(bare.prompt).toBe("");
    expect(bare.avatar).toBe("bot");
    expect(
      parseAgent({
        ...defaults,
        name: "coder",
        providerId: "p",
        model: "m",
        avatar: "dome",
      }).avatar,
    ).toBe("dome");
    expect(
      parseAgent({
        ...defaults,
        name: "coder",
        providerId: "p",
        model: "m",
        prompt: " x \n",
      }).prompt,
    ).toBe("x");
  });

  test("are made on a listed model and keep what the catalog said", async () => {
    const { app, client, provider } = await setup();
    const res = await client.call("POST", "/api/agents", {
      body: {
        ...defaults,
        name: "coder",
        providerId: provider.id,
        model: flash.id,
        avatar: "boxy",
        thinking: "on",
        effort: "xhigh",
        prompt: "You write Go.",
      },
    });
    expect(res.status).toBe(201);
    const { agent } = await res.json();
    expect(agent).toEqual({
      id: expect.any(String),
      name: "coder",
      avatar: "boxy",
      providerId: provider.id,
      model: flash,
      thinking: "on",
      effort: "xhigh",
      prompt: "You write Go.",
      skills: [],
      servers: [],
      mcpMode: "auto",
      upstream: null,
      skip4Bit: false,
      subagents: false,
      // the first agent is the default until an admin marks another
      default: true,
      createdAt: app.now.value,
    });
    expect(await (await client.call("GET", "/api/agents")).json()).toEqual({
      agents: [agent],
      activity: [],
    });
  });

  test("the subagents switch starts off, saves, reads back and drops when left out", async () => {
    const { app, client, provider } = await setup();
    const body = {
      ...defaults,
      name: "coder",
      providerId: provider.id,
      model: flash.id,
    };
    const made = await client.call("POST", "/api/agents", { body });
    expect(made.status).toBe(201);
    const { agent } = await made.json();
    expect(agent.subagents).toBe(false);
    const on = await client.call("PATCH", `/api/agents/${agent.id}`, {
      body: { ...body, subagents: true },
    });
    expect(on.status).toBe(200);
    expect((await on.json()).agent.subagents).toBe(true);
    const listed = await (await client.call("GET", "/api/agents")).json();
    expect(listed.agents[0].subagents).toBe(true);
    expect(
      app.db.query("select subagents from agents where id = ?").get(agent.id),
    ).toEqual({ subagents: 1 });
    const odd = await client.call("PATCH", `/api/agents/${agent.id}`, {
      body: { ...body, subagents: "yes" },
    });
    expect(odd.status).toBe(400);
    expect(await odd.json()).toEqual({
      error: "subagents must be true or false",
    });
    // the route takes the whole agent: left out is off
    const off = await client.call("PATCH", `/api/agents/${agent.id}`, {
      body,
    });
    expect((await off.json()).agent.subagents).toBe(false);
  });

  test("a model that always or never thinks drops the thinking word", async () => {
    const { client, provider } = await setup();
    const body = {
      ...defaults,
      name: "coder",
      providerId: provider.id,
      model: "openai/gpt-6-astra",
      thinking: "off",
    };
    const res = await client.call("POST", "/api/agents", { body });
    expect(res.status).toBe(201);
    const { agent } = await res.json();
    expect(agent.thinking).toBeNull();
    expect(agent.model.thinkingRequired).toBe(true);
    // a save that sends the word again, as a stale form or provisioning
    // does, still goes through
    const again = await client.call("PATCH", `/api/agents/${agent.id}`, {
      body: { ...body, prompt: "p" },
    });
    expect(again.status).toBe(200);
    expect((await again.json()).agent.thinking).toBeNull();
    const plain = await client.call("POST", "/api/agents", {
      body: {
        ...body,
        name: "plain",
        model: "deepseek/deepseek-chat",
        thinking: "on",
      },
    });
    expect(plain.status).toBe(201);
    expect((await plain.json()).agent.thinking).toBeNull();
  });

  test("an unknown MCP server rolls the agent save back", async () => {
    const { app, client, provider } = await setup();
    const res = await client.call("POST", "/api/agents", {
      body: {
        ...defaults,
        name: "coder",
        providerId: provider.id,
        model: flash.id,
        servers: [{ serverId: "missing", read: true, write: false }],
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("serverId is unknown");
    expect(app.agents.list()).toEqual([]);
  });

  test("a model the catalog does not list, or a provider that is not there, is refused", async () => {
    const { client, provider } = await setup();
    const unknown = await client.call("POST", "/api/agents", {
      body: {
        ...defaults,
        name: "coder",
        providerId: provider.id,
        model: "nobody/nothing",
      },
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({
      error: "router does not list nobody/nothing",
    });
    const gone = await client.call("POST", "/api/agents", {
      body: { ...defaults, name: "coder", providerId: "none", model: flash.id },
    });
    expect(gone.status).toBe(400);
  });

  test("refuses effort outside the provider wire table", async () => {
    const { client, provider } = await setup();
    const invalid = await client.call("POST", "/api/agents", {
      body: {
        ...defaults,
        name: "coder",
        providerId: provider.id,
        model: flash.id,
        effort: "extreme",
      },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "effort must be one of minimal, low, medium, high, xhigh",
    });

    const { agent } = await (
      await client.call("POST", "/api/agents", {
        body: {
          ...defaults,
          name: "coder",
          providerId: provider.id,
          model: flash.id,
        },
      })
    ).json();
    const { provider: plain } = await (
      await client.call("POST", "/api/providers", {
        body: {
          name: "plain",
          wire: "openai-compatible",
          baseUrl: "http://plain.test/v1",
          keyName: null,
        },
      })
    ).json();
    const patch = await client.call("PATCH", `/api/agents/${agent.id}`, {
      body: {
        ...defaults,
        name: "coder",
        providerId: plain.id,
        model: flash.id,
        effort: "minimal",
      },
    });
    expect(patch.status).toBe(400);
    expect(await patch.json()).toEqual({
      error: "effort must be one of low, medium, high",
    });
  });

  test("a dead provider is a 502", async () => {
    const { client } = await setup();
    const { provider } = await (
      await client.call("POST", "/api/providers", {
        body: {
          name: "down",
          wire: "openai-compatible",
          baseUrl: "http://down.test/v1",
          keyName: null,
        },
      })
    ).json();
    const res = await client.call("POST", "/api/agents", {
      body: { ...defaults, name: "coder", providerId: provider.id, model: "x" },
    });
    expect(res.status).toBe(502);
  });

  test("a name is taken once, and a save keeps its own", async () => {
    const { client, provider } = await setup();
    const make = (name: string) =>
      client.call("POST", "/api/agents", {
        body: { ...defaults, name, providerId: provider.id, model: flash.id },
      });
    const { agent } = await (await make("coder")).json();
    expect((await make("coder")).status).toBe(409);
    const { agent: other } = await (await make("other")).json();
    const patch = (id: string, name: string, model = flash.id) =>
      client.call("PATCH", `/api/agents/${id}`, {
        body: { ...defaults, name, providerId: provider.id, model },
      });
    expect((await patch(other.id, "coder")).status).toBe(409);
    const same = await patch(agent.id, "coder", "deepseek/deepseek-chat");
    expect(same.status).toBe(200);
    const { agent: changed } = await same.json();
    expect(changed.model.id).toBe("deepseek/deepseek-chat");
    expect(changed.createdAt).toBe(agent.createdAt);
    expect((await patch("none", "x")).status).toBe(404);
  });

  test("a race with a delete or a twin name ends in the right status", async () => {
    const { app, client, provider } = await setup();
    // the catalog answers only when told, so a second request can move
    // the world while the first waits
    const gates: (() => void)[] = [];
    const held = ((input: string, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        gates.push(() => {
          void realFetcher(input, init).then(resolve);
        });
      })) as unknown as typeof fetch;
    const realFetcher = fakeFetch().fetcher;
    const catalogs = new Catalogs({
      fetcher: held,
      clock: () => app.now.value,
      secret: () => null,
    });
    Object.assign(app.catalogs, {
      models: (p: ProviderRow) => catalogs.models(p),
    });
    const body = {
      ...defaults,
      name: "coder",
      providerId: provider.id,
      model: flash.id,
    };
    const a = client.call("POST", "/api/agents", { body });
    await new Promise((r) => setTimeout(r, 5));
    const twin = client.call("POST", "/api/agents", { body });
    await new Promise((r) => setTimeout(r, 5));
    for (const g of gates) g();
    const [first, second] = await Promise.all([a, twin]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const { agent } = await (first.status === 201 ? first : second).json();
    const server = app.mcp.create(
      {
        name: "cluster",
        url: "http://cluster.test/mcp",
        keyName: null,
        read: true,
        write: false,
        instructionsOn: true,
        timeoutMs: null,
        readPatterns: ["*"],
        writePatterns: [],
        excludedPatterns: [],
      },
      {
        serverName: "cluster",
        serverVersion: "1",
        protocolEra: "modern",
        protocolVersion: "2026-07-28",
        instructions: "",
        fingerprint: "fingerprint",
        checkedAt: app.now.value,
        tools: [],
      },
    );
    catalogs.forget(provider.id);
    const vanished = client.call("POST", "/api/agents", {
      body: {
        ...body,
        name: "vanished-server",
        servers: [{ serverId: server.id, read: true, write: false }],
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(app.mcp.deleteUnreferenced(server.id)).toBe("deleted");
    for (const g of gates) g();
    const vanishedResponse = await vanished;
    expect(vanishedResponse.status).toBe(400);
    expect(await vanishedResponse.json()).toEqual({
      error: "serverId is unknown",
    });
    expect(app.agents.byName("vanished-server")).toBeNull();
    // a PATCH whose agent goes while the catalog is asked
    catalogs.forget(provider.id);
    const patch = client.call("PATCH", `/api/agents/${agent.id}`, {
      body: { ...body, name: "other" },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(
      (await client.call("DELETE", `/api/agents/${agent.id}`)).status,
    ).toBe(200);
    for (const g of gates) g();
    expect((await patch).status).toBe(404);
    // a POST whose provider goes while the catalog is asked
    catalogs.forget(provider.id);
    const late = client.call("POST", "/api/agents", { body });
    await new Promise((r) => setTimeout(r, 5));
    expect(
      (await client.call("DELETE", `/api/providers/${provider.id}`)).status,
    ).toBe(200);
    for (const g of gates) g();
    expect((await late).status).toBe(400);
  });

  test("one goes, and a missing one is a 404", async () => {
    const { app, client, provider } = await setup();
    const { agent } = await (
      await client.call("POST", "/api/agents", {
        body: {
          ...defaults,
          name: "coder",
          providerId: provider.id,
          model: flash.id,
        },
      })
    ).json();
    expect(
      (await client.call("DELETE", `/api/agents/${agent.id}`)).status,
    ).toBe(200);
    expect(app.agents.list()).toEqual([]);
    expect(
      (await client.call("DELETE", `/api/agents/${agent.id}`)).status,
    ).toBe(404);
  });
});

describe("a model its catalog does not describe", () => {
  const ULTRA = "nvidia/nemotron-3-ultra-550b-a55b";
  const nim = async () => {
    const { app, client, provider: router } = await setup();
    const { provider } = await (
      await client.call("POST", "/api/providers", {
        body: {
          name: "nvidia",
          wire: "openai-strict",
          baseUrl: NIM_URL,
          keyName: null,
        },
      })
    ).json();
    const save = (body: Record<string, unknown>, id?: string) =>
      client.call(id ? "PATCH" : "POST", `/api/agents${id ? `/${id}` : ""}`, {
        body: {
          name: "nim",
          providerId: provider.id,
          model: ULTRA,
          ...defaults,
          ...body,
        },
      });
    return { app, client, provider, router, save };
  };

  test("takes the window and the tools flag the admin states", async () => {
    const { save } = await nim();
    const res = await save({ contextLength: 262144, tools: true });
    expect(res.status).toBe(201);
    expect((await res.json()).agent.model).toEqual({
      id: ULTRA,
      name: ULTRA,
      contextLength: 262144,
      promptPrice: null,
      completionPrice: null,
      tools: true,
      reasoning: false,
      thinkingRequired: false,
      reasoningKnown: false,
      described: false,
    });
  });

  test("without them it has no window and no tools", async () => {
    const { save } = await nim();
    const res = await save({});
    expect(res.status).toBe(201);
    expect((await res.json()).agent.model).toMatchObject({
      contextLength: null,
      tools: false,
      described: false,
    });
  });

  test("tools need a window, since the loop weighs it before calls", async () => {
    const { save } = await nim();
    const res = await save({ tools: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "contextLength is required for a model with tools",
    );
  });

  test("a model the catalog describes is never overridden", async () => {
    const { router, save } = await nim();
    const res = await save({
      providerId: router.id,
      model: flash.id,
      contextLength: 1024,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "contextLength and tools are only for a model the catalog does not describe",
    );
  });

  test("a save that leaves them out clears them", async () => {
    const { save } = await nim();
    const { agent } = await (
      await save({ contextLength: 262144, tools: true })
    ).json();
    const res = await save({ model: "01-ai/yi-large" }, agent.id);
    expect(res.status).toBe(200);
    expect((await res.json()).agent.model).toMatchObject({
      id: "01-ai/yi-large",
      contextLength: null,
      tools: false,
      described: false,
    });
  });

  test("the wire's levels leave out minimal", async () => {
    const { save } = await nim();
    const res = await save({ thinking: "on", effort: "minimal" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "effort must be one of low, medium, high",
    );
  });

  refuses(
    [
      { contextLength: 999 },
      { contextLength: 10_000_001 },
      { contextLength: 4096.5 },
      { contextLength: "4096" },
      { tools: "yes" },
      { tools: null },
    ].map((extra) => ({
      name: "nim",
      providerId: "p",
      model: "m",
      ...defaults,
      ...extra,
    })),
    parseAgent,
  );
});

describe("an opencode agent", () => {
  const MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
  // an ids-only catalog, as OpenCode Go answers
  const go = async () => {
    const { client } = await setup();
    const { provider } = await (
      await client.call("POST", "/api/providers", {
        body: { name: "go", wire: "opencode", baseUrl: NIM_URL, keyName: null },
      })
    ).json();
    const save = (body: Record<string, unknown>) =>
      client.call("POST", "/api/agents", {
        body: {
          name: "go",
          providerId: provider.id,
          model: MODEL,
          ...defaults,
          ...body,
        },
      });
    return { provider, save };
  };

  test("takes max and the window the admin states", async () => {
    const { provider, save } = await go();
    expect(provider.wire).toBe("opencode");
    const res = await save({
      thinking: "on",
      effort: "max",
      contextLength: 1_000_000,
      tools: true,
    });
    expect(res.status).toBe(201);
    expect((await res.json()).agent).toMatchObject({
      thinking: "on",
      effort: "max",
      upstream: null,
      skip4Bit: false,
      model: {
        id: MODEL,
        contextLength: 1_000_000,
        tools: true,
        reasoningKnown: false,
        described: false,
      },
    });
  });

  test("refuses another wire's levels and OpenRouter's host fields", async () => {
    const { save } = await go();
    for (const effort of ["minimal", "xhigh"]) {
      const res = await save({ thinking: "on", effort });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "effort must be one of low, medium, high, max",
      });
    }
    for (const [field, value] of [
      ["upstream", "deepinfra/fp4"],
      ["skip4Bit", true],
    ] as const) {
      const res = await save({ [field]: value });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: `${field} is only for an OpenRouter provider`,
      });
    }
  });
});

describe("a preferred upstream", () => {
  const GLM = "z-ai/glm-5.3-flash";
  const strict = async (client: Awaited<ReturnType<typeof setup>>["client"]) =>
    (
      await (
        await client.call("POST", "/api/providers", {
          body: {
            name: "nim",
            wire: "openai-compatible",
            baseUrl: NIM_URL,
            keyName: null,
          },
        })
      ).json()
    ).provider;

  test("the endpoints route lists who serves an OpenRouter model", async () => {
    const { client, provider } = await setup();
    const res = await client.call(
      "GET",
      `/api/providers/${provider.id}/endpoints?model=${GLM}`,
    );
    expect(res.status).toBe(200);
    const { endpoints } = await res.json();
    expect(endpoints.map((e: { tag: string }) => e.tag)).toEqual([
      "inference-net/fp4",
      "deepinfra/fp4",
      "relace",
      "baseten/fp8",
      "cloudflare",
    ]);
    const unlisted = await client.call(
      "GET",
      `/api/providers/${provider.id}/endpoints?model=nobody/nothing`,
    );
    expect(unlisted.status).toBe(502);
    for (const model of [
      "",
      "bare",
      "a/b?c",
      "../..",
      "a/..",
      "x".repeat(201),
    ]) {
      const bad = await client.call(
        "GET",
        `/api/providers/${provider.id}/endpoints?model=${encodeURIComponent(model)}`,
      );
      expect(bad.status).toBe(400);
    }
    const other = await strict(client);
    const refused = await client.call(
      "GET",
      `/api/providers/${other.id}/endpoints?model=${GLM}`,
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: "only an OpenRouter provider lists endpoints",
    });
  });

  test("is saved when it serves the model and refused otherwise", async () => {
    const { app, client, provider } = await setup();
    const body = {
      ...defaults,
      name: "coder",
      providerId: provider.id,
      model: GLM,
    };
    const made = await client.call("POST", "/api/agents", {
      body: { ...body, upstream: "deepinfra/fp4" },
    });
    expect(made.status).toBe(201);
    const { agent } = await made.json();
    expect(agent.upstream).toBe("deepinfra/fp4");
    const unknown = await client.call("PATCH", `/api/agents/${agent.id}`, {
      body: { ...body, upstream: "nobody" },
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({
      error: `The preferred provider nobody does not serve ${GLM} on router`,
    });
    for (const upstream of ["a b", "../x", "a/.."]) {
      const malformed = await client.call("PATCH", `/api/agents/${agent.id}`, {
        body: { ...body, upstream },
      });
      expect(malformed.status).toBe(400);
    }
    // a provider that does not answer for the model is the 502 it is
    const unanswered = await client.call("PATCH", `/api/agents/${agent.id}`, {
      body: { ...body, model: "z-ai/glm-5.3", upstream: "relace" },
    });
    expect(unanswered.status).toBe(502);
    // a tag that stopped serving stays while the model and the tag do
    app.db.run("update agents set upstream = 'gone' where id = ?", [agent.id]);
    const kept = await client.call("PATCH", `/api/agents/${agent.id}`, {
      body: { ...body, prompt: "edited", upstream: "gone" },
    });
    expect(kept.status).toBe(200);
    // left out is any upstream
    const cleared = await client.call("PATCH", `/api/agents/${agent.id}`, {
      body,
    });
    expect((await cleared.json()).agent.upstream).toBeNull();
  });

  test("skipping 4-bit hosts saves, reads back and refuses a 4-bit upstream", async () => {
    const { client, provider } = await setup();
    const body = {
      ...defaults,
      name: "coder",
      providerId: provider.id,
      model: GLM,
    };
    const made = await client.call("POST", "/api/agents", {
      body: { ...body, skip4Bit: true, upstream: "baseten/fp8" },
    });
    expect(made.status).toBe(201);
    const { agent } = await made.json();
    expect(agent).toMatchObject({ skip4Bit: true, upstream: "baseten/fp8" });
    const listed = await (await client.call("GET", "/api/agents")).json();
    expect(listed.agents[0].skip4Bit).toBe(true);
    for (const upstream of ["deepinfra/fp4", "inference-net/fp4"]) {
      const refused = await client.call("PATCH", `/api/agents/${agent.id}`, {
        body: { ...body, skip4Bit: true, upstream },
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: `The preferred provider ${upstream} is a 4-bit host, which Skip 4-bit providers leaves out`,
      });
    }
    const odd = await client.call("PATCH", `/api/agents/${agent.id}`, {
      body: { ...body, skip4Bit: "yes" },
    });
    expect(odd.status).toBe(400);
    // a 4-bit upstream with fallbacks of any precision stays a choice
    const pinned = await client.call("PATCH", `/api/agents/${agent.id}`, {
      body: { ...body, upstream: "deepinfra/fp4" },
    });
    expect(pinned.status).toBe(200);
    // left out is off
    expect((await pinned.json()).agent.skip4Bit).toBe(false);
  });

  test("a 4-bit host is known by its endpoint's precision before its tag", async () => {
    const fake = fakeFetch();
    const recorded = JSON.parse(
      await (
        await fake.fetcher(`${PROVIDER_URL}/models/${GLM}/endpoints`)
      ).text(),
    );
    // the endpoint says otherwise than the tag
    for (const e of recorded.data.endpoints) {
      if (e.tag === "relace") e.quantization = "FP4";
      if (e.tag === "deepinfra/fp4") e.quantization = "fp8";
    }
    const fetcher = (async (input: unknown, init?: RequestInit) =>
      String(input) === `${PROVIDER_URL}/models/${GLM}/endpoints`
        ? new Response(JSON.stringify(recorded), {
            headers: { "content-type": "application/json" },
          })
        : fake.fetcher(input as string, init)) as unknown as typeof fetch;
    const { client, provider } = await setup(fetcher);
    const body = {
      ...defaults,
      name: "coder",
      providerId: provider.id,
      model: GLM,
      skip4Bit: true,
    };
    const refused = await client.call("POST", "/api/agents", {
      body: { ...body, upstream: "relace" },
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error:
        "The preferred provider relace is a 4-bit host, which Skip 4-bit providers leaves out",
    });
    const made = await client.call("POST", "/api/agents", {
      body: { ...body, upstream: "deepinfra/fp4" },
    });
    expect(made.status).toBe(201);
  });

  test("is refused for a model whose every serving host is 4-bit", async () => {
    // the recorded answer with only its fp4 hosts
    const fourBit = readFileSync(
      join(
        import.meta.dir,
        "..",
        "fixtures",
        "providers",
        "openrouter",
        "endpoints-4bit.json",
      ),
      "utf8",
    );
    const full = JSON.parse(
      await (
        await fakeFetch().fetcher(`${PROVIDER_URL}/models/${GLM}/endpoints`)
      ).text(),
    );
    // every host but the fp4 ones without tools, for a model that takes them
    for (const e of full.data.endpoints) {
      if (e.quantization !== "fp4") {
        e.supported_parameters = e.supported_parameters.filter(
          (p: string) => p !== "tools" && p !== "tool_choice",
        );
      }
    }
    let answer = fourBit;
    let calls = 0;
    const fake = fakeFetch();
    const fetcher = (async (input: unknown, init?: RequestInit) => {
      if (String(input) !== `${PROVIDER_URL}/models/${GLM}/endpoints`) {
        return fake.fetcher(input as string, init);
      }
      calls++;
      return new Response(answer, {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const { client, provider } = await setup(fetcher);
    const body = {
      ...defaults,
      name: "coder",
      providerId: provider.id,
      model: GLM,
    };
    const refused = await client.call("POST", "/api/agents", {
      body: { ...body, skip4Bit: true },
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: `Skip 4-bit providers leaves no provider serving ${GLM}`,
    });
    // without the filter it saves, and a save that keeps it asks nothing
    const made = await client.call("POST", "/api/agents", { body });
    expect(made.status).toBe(201);
    const { agent } = await made.json();
    answer = JSON.stringify(full);
    const tools = await client.call("PATCH", `/api/agents/${agent.id}`, {
      body: { ...body, skip4Bit: true },
    });
    expect(tools.status).toBe(400);
    expect((await tools.json()).error).toStartWith("Skip 4-bit providers");
    // a list that fails cannot judge
    answer = "not json";
    const unjudged = await client.call("PATCH", `/api/agents/${agent.id}`, {
      body: { ...body, skip4Bit: true },
    });
    expect(unjudged.status).toBe(200);
    const before = calls;
    const kept = await client.call("PATCH", `/api/agents/${agent.id}`, {
      body: { ...body, skip4Bit: true, prompt: "edited" },
    });
    expect(kept.status).toBe(200);
    expect(calls).toBe(before);
  });

  test("a 4-bit host is known by its tag when the endpoints do not answer", async () => {
    const { app, client, provider } = await setup();
    // the catalog lists this model and its endpoints answer 404
    const body = {
      ...defaults,
      name: "coder",
      providerId: provider.id,
      model: "z-ai/glm-5.3",
    };
    const made = await client.call("POST", "/api/agents", { body });
    expect(made.status).toBe(201);
    const { agent } = await made.json();
    for (const [upstream, status] of [
      ["gone/FP4", 400],
      ["gone", 200],
    ] as const) {
      app.db.run("update agents set upstream = ? where id = ?", [
        upstream,
        agent.id,
      ]);
      const saved = await client.call("PATCH", `/api/agents/${agent.id}`, {
        body: { ...body, upstream, skip4Bit: true },
      });
      expect(saved.status).toBe(status);
    }
  });

  test("is refused on another wire", async () => {
    const { client } = await setup();
    const other = await strict(client);
    const res = await client.call("POST", "/api/agents", {
      body: {
        ...defaults,
        name: "coder",
        providerId: other.id,
        model: "meta/llama-3.3-70b-instruct",
        upstream: "deepinfra/fp4",
      },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "upstream is only for an OpenRouter provider",
    });
    const filtered = await client.call("POST", "/api/agents", {
      body: {
        ...defaults,
        name: "coder",
        providerId: other.id,
        model: "meta/llama-3.3-70b-instruct",
        skip4Bit: true,
      },
    });
    expect(filtered.status).toBe(400);
    expect(await filtered.json()).toEqual({
      error: "skip4Bit is only for an OpenRouter provider",
    });
  });
});

describe("an agent's output", () => {
  test("a chat round sends no max_tokens", async () => {
    const chat = await chatApp({ wire: "openrouter" });
    try {
      const started = await startChat(chat);
      expect(started.script.body).not.toHaveProperty("max_tokens");
      started.script.reply("done");
      await settleRun(chat, started.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });
});
