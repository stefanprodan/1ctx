// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { imagesOf } from "../../../src/server/agents/routes.ts";
import type { CatalogMatch } from "../../../src/shared/contracts/provider.ts";
import {
  ANTHROPIC_URL,
  fakeFetch,
  GROQ_URL,
  NIM_URL,
  testApp,
} from "../../helpers/app.ts";

// a local server that lists a window and nothing of what it reads
const LOCAL_URL = "http://local.test/v1";
const LOCAL_MODEL = "local/vision";

async function setup() {
  const fake = fakeFetch();
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === `${LOCAL_URL}/models`
      ? Response.json({ data: [{ id: LOCAL_MODEL, context_length: 32768 }] })
      : fake.fetcher(input, init)) as typeof fetch;
  const app = await testApp({ fetcher });
  const client = app.client();
  await client.login("admin", "hunter2-test");
  const provider = async (name: string, wire: string, baseUrl: string) =>
    (
      await (
        await client.call("POST", "/api/providers", {
          body: { name, wire, baseUrl, keyName: null },
        })
      ).json()
    ).provider.id as string;
  const save = (
    providerId: string,
    model: string,
    extra: Record<string, unknown> = {},
    id?: string,
  ) =>
    client.call(id ? "PATCH" : "POST", `/api/agents${id ? `/${id}` : ""}`, {
      body: {
        name: "seer",
        providerId,
        model,
        thinking: null,
        effort: null,
        servers: [],
        mcpMode: "auto",
        ...extra,
      },
    });
  return { app, client, provider, save };
}

test("the catalog's word wins, and the admin's counts only where it is silent", () => {
  const model = (images: boolean | null) => ({ images }) as CatalogMatch;
  expect(imagesOf(model(true), null)).toBe(true);
  expect(imagesOf(model(false), null)).toBe(false);
  expect(() => imagesOf(model(true), false)).toThrow(/only for a model/);
  expect(imagesOf(model(null), null)).toBe(false);
  expect(imagesOf(model(null), true)).toBe(true);
});

test("a described model whose catalog is silent takes the stated flag", async () => {
  const s = await setup();
  const local = await s.provider("local", "openai-compatible", LOCAL_URL);
  const made = await s.save(local, LOCAL_MODEL, { images: true });
  expect(made.status).toBe(201);
  const { agent } = await made.json();
  expect(agent.model).toMatchObject({ described: true, images: null });
  expect(agent.images).toBe(true);
  // a save that leaves it out turns it off, as the tools flag does
  const off = await s.save(local, LOCAL_MODEL, {}, agent.id);
  expect((await off.json()).agent.images).toBe(false);
  const bad = await s.save(local, LOCAL_MODEL, { images: "yes" }, agent.id);
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: "images must be true or false" });
});

test("an undescribed model takes it beside its window", async () => {
  const s = await setup();
  const nim = await s.provider("nvidia", "openai-strict", NIM_URL);
  const made = await s.save(nim, "nvidia/nemotron-3-ultra-550b-a55b", {
    images: true,
    contextLength: 131072,
  });
  expect(made.status).toBe(201);
  const { agent } = await made.json();
  expect(agent.model).toMatchObject({ described: false, images: null });
  expect(agent.images).toBe(true);
});

test("a catalog that says refuses the admin's word, yes or no", async () => {
  const s = await setup();
  const claude = await s.provider("claude", "anthropic", ANTHROPIC_URL);
  const made = await s.save(claude, "claude-haiku-5-5");
  expect(made.status).toBe(201);
  const { agent } = await made.json();
  // the recorded catalog lists image_input
  expect([agent.model.images, agent.images]).toEqual([true, true]);
  const stated = await s.save(
    claude,
    "claude-haiku-5-5",
    { images: true },
    agent.id,
  );
  expect(stated.status).toBe(400);
  const groq = await s.provider("groq", "openai-strict", GROQ_URL);
  const text = await s.save(groq, "openai/gpt-oss-120b", {}, agent.id);
  expect(text.status).toBe(200);
  // Groq lists text as its only input
  expect((await text.json()).agent).toMatchObject({
    model: { images: false },
    images: false,
  });
  const refused = await s.save(
    groq,
    "openai/gpt-oss-120b",
    { images: true },
    agent.id,
  );
  expect(refused.status).toBe(400);
  expect(s.app.agents.byId(agent.id)!.images).toBe(false);
});
