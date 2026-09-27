// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import type {
  AgentsResponse,
  AgentUsageResponse,
} from "../../../src/shared/api/agents.ts";
import { chatApp, FLASH, startChat, tick } from "../../helpers/chat.ts";

async function activity(chat: Awaited<ReturnType<typeof chatApp>>) {
  const res = await chat.admin.call("GET", "/api/agents");
  expect(res.status).toBe(200);
  return ((await res.json()) as AgentsResponse).activity;
}

test("the agents list says when each agent last ran and what runs now", async () => {
  const chat = await chatApp();
  const idle = await chat.makeAgent({ name: "idle", model: FLASH });
  expect(await activity(chat)).toEqual([]);

  const started = await startChat(chat);
  const at = chat.app.now.value;
  expect(await activity(chat)).toEqual([
    { agentId: chat.agentId, lastAt: at, running: true },
  ]);

  started.script.reply("done");
  for (let i = 0; i < 50; i++) {
    if (!(await activity(chat))[0]?.running) break;
    await tick();
  }
  const after = await activity(chat);
  expect(after).toEqual([
    { agentId: chat.agentId, lastAt: at, running: false },
  ]);
  expect(after.some((a) => a.agentId === idle)).toBe(false);
});

test("an agent's usage sums its last 30 days, cost 0 with none and null when unpriced", async () => {
  const chat = await chatApp();
  const empty = await chat.admin.call(
    "GET",
    `/api/agents/${chat.agentId}/usage`,
  );
  expect(await empty.json()).toMatchObject({ sends: 0, tokens: 0, cost: 0 });
  const started = await startChat(chat);
  started.script.reply("done");
  for (let i = 0; i < 50; i++) {
    const res = await chat.admin.call(
      "GET",
      `/api/agents/${chat.agentId}/usage`,
    );
    const body = (await res.json()) as AgentUsageResponse;
    if (body.sends === 1) {
      expect(body.tokens).toBeGreaterThan(0);
      expect(body.cost).toBeNull();
      expect(body.until - body.since).toBe(30 * 24 * 60 * 60 * 1000);
      return;
    }
    await tick();
  }
  throw new Error("the turn never counted");
});
