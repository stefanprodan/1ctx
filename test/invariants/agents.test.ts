// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent names a provider and a model the provider's catalog lists;
// what the catalog said about the model rides on the row.

import { describe, expect, test } from "bun:test";
import { parseAgent } from "../../src/server/agents/parse.ts";
import {
  Catalogs,
  type ProviderRow,
} from "../../src/server/providers/index.ts";
import { fakeFetch, NIM_URL, PROVIDER_URL, testApp } from "../helpers/app.ts";
import { chatApp } from "../helpers/chat.ts";
import { refuses } from "../helpers/refuses.ts";

const setup = async () => {
  const app = await testApp();
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
      expect(body.capabilities).toEqual(mode === "off" ? [] : ["web"]);
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
    ).toThrow("a server needs read or write");
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
      createdAt: app.now.value,
    });
    expect(await (await client.call("GET", "/api/agents")).json()).toEqual({
      agents: [agent],
    });
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
      { contextLength: 1023 },
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
