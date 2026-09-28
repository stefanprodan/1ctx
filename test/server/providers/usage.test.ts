// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/index.ts";
import { UsageStore } from "../../../src/server/usage/store.ts";
import type { SendTotalsResponse } from "../../../src/shared/api/admin.ts";
import { chatApp, startChat, tick } from "../../helpers/chat.ts";

const DAY = 24 * 60 * 60 * 1000;

test("a provider's usage sums its agents' last 30 days", async () => {
  const chat = await chatApp();
  const read = async () => {
    // the window is [since, until): a row stamped now is not in it yet
    chat.app.now.value += 1;
    const res = await chat.admin.call(
      "GET",
      `/api/providers/${chat.providerId}/usage`,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as SendTotalsResponse;
  };
  expect(await read()).toMatchObject({ sends: 0, tokens: 0, cost: 0 });
  const started = await startChat(chat);
  started.script.reply("done");
  let counted: SendTotalsResponse | null = null;
  for (let i = 0; i < 50 && counted === null; i++) {
    const body = await read();
    if (body.sends === 1) counted = body;
    else await tick();
  }
  if (counted === null) throw new Error("the turn never counted");
  expect(counted.tokens).toBeGreaterThan(0);
  expect(counted.cost).toBeNull();
  expect(counted.until - counted.since).toBe(30 * DAY);
  // past the window the turn no longer counts; the store is read
  // directly, since a month on the clock would end the login too
  const later = counted.until + 30 * DAY + 1;
  expect(
    new UsageStore(chat.app.db).total(
      { providerId: chat.providerId },
      later - 30 * DAY,
      later,
    ),
  ).toEqual({ sends: 0, tokens: 0, cost: 0 });
  const gone = await chat.admin.call("GET", "/api/providers/nope/usage");
  expect(gone.status).toBe(404);
});

describe("a usage total", () => {
  const fields = (
    providerId: string,
    now: number,
    cost: number | null,
    n: number,
  ) => ({
    sendId: `s${n}`,
    sessionId: "c1",
    projectId: `p-${providerId}`,
    userId: "u1",
    agentId: `a-${providerId}`,
    providerId,
    model: "m",
    round: 0,
    promptTokens: 10,
    completionTokens: 5,
    cachedTokens: null,
    reasoningTokens: null,
    cost,
    contextLength: null,
    upstream: null,
    servedModel: null,
    now,
  });

  test("counts its own rows in [since, until), a priced part summed", () => {
    const db = new Database(":memory:");
    migrate(db as never);
    const store = new UsageStore(db as never);
    store.record(fields("mine", 50, 9, 1));
    store.record(fields("mine", 100, null, 2));
    store.record(fields("other", 100, 2, 3));
    store.record(fields("mine", 49, 7, 4));
    store.record(fields("mine", 150, 7, 5));
    for (const by of [
      { providerId: "mine" },
      { agentId: "a-mine" },
      { projectId: "p-mine" },
    ]) {
      expect(store.total(by, 50, 150)).toMatchObject({
        tokens: 30,
        cost: 9,
      });
    }
    expect(store.total({ providerId: "other" }, 50, 150)).toMatchObject({
      tokens: 15,
      cost: 2,
    });
    expect(store.total({ agentId: "none" }, 50, 150)).toEqual({
      sends: 0,
      tokens: 0,
      cost: 0,
    });
  });

  test("an agent's and a provider's totals read their index alone", () => {
    const db = new Database(":memory:");
    migrate(db as never);
    for (const column of ["provider_id", "agent_id"]) {
      const plan = db
        .query<{ detail: string }, [string, number, number]>(
          `explain query plan select sum(prompt_tokens + completion_tokens),
             sum(cost), count(distinct send_id) from usage
           where ${column} = ? and created_at >= ? and created_at < ?`,
        )
        .all("x", 0, 1)
        .map((row) => row.detail)
        .join(" ");
      expect(plan).toContain("USING COVERING INDEX");
    }
  });
});
