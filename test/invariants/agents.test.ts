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
import { fakeFetch, PROVIDER_URL, testApp } from "../helpers/app.ts";
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
};

const defaults = { thinking: null, effort: null } as const;

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
      createdAt: app.now.value,
    });
    expect(await (await client.call("GET", "/api/agents")).json()).toEqual({
      agents: [agent],
    });
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
