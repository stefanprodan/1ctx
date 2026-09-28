// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test";
import {
  agents,
  factsFor,
  loadFacts,
} from "../../../src/client/data/agents.ts";
import { me } from "../../../src/client/data/me.ts";
import type { AgentSummary } from "../../../src/shared/contracts/agent.ts";

const realFetch = globalThis.fetch;

const user = (id: string) => ({
  id,
  username: id,
  fullName: id,
  role: "admin" as const,
  mustChangePassword: false,
});

const agent = { id: "ag1", name: "coder" } as AgentSummary;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  globalThis.fetch = realFetch;
  me.value = undefined;
});

test.serial("an agent's facts are read by its id and kept", async () => {
  me.value = user("u1");
  agents.value = [agent];
  const urls: string[] = [];
  globalThis.fetch = ((url: string) => {
    urls.push(String(url));
    return Promise.resolve(
      String(url).endsWith("/usage")
        ? json({ since: 0, until: 1, sends: 2, tokens: 10, cost: null })
        : new Response("no", { status: 500 }),
    );
  }) as unknown as typeof fetch;
  expect(factsFor("ag1")).toBeUndefined();
  await loadFacts("coder");
  expect(urls.sort()).toEqual([
    "/api/agents/ag1/impact",
    "/api/agents/ag1/usage",
  ]);
  expect(factsFor("ag1")).toEqual({
    usage: { since: 0, until: 1, sends: 2, tokens: 10, cost: null },
    impact: null,
  });
});

test.serial("a read in flight across a sign-out lands for no one", async () => {
  me.value = user("u1");
  agents.value = [agent];
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  globalThis.fetch = (async () => {
    await gate;
    return json({ sends: 1, tokens: 1, cost: null });
  }) as unknown as typeof fetch;
  const late = loadFacts("coder");
  me.value = user("u2");
  release();
  await late;
  expect(factsFor("ag1")).toBeUndefined();
});
