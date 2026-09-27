// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { UsageStore } from "../../../src/server/usage/store.ts";
import type { ProviderUsageResponse } from "../../../src/shared/api/providers.ts";
import { chatApp, startChat, tick } from "../../helpers/chat.ts";

const DAY = 24 * 60 * 60 * 1000;

test("a provider's usage sums its agents' last 30 days", async () => {
  const chat = await chatApp();
  const read = async () => {
    const res = await chat.admin.call(
      "GET",
      `/api/providers/${chat.providerId}/usage`,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as ProviderUsageResponse;
  };
  expect(await read()).toMatchObject({ sends: 0, tokens: 0, cost: 0 });
  const started = await startChat(chat);
  started.script.reply("done");
  let counted: ProviderUsageResponse | null = null;
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
    new UsageStore(chat.app.db).providerTotal(
      chat.providerId,
      later - 30 * DAY,
      later,
    ),
  ).toEqual({ sends: 0, tokens: 0, cost: 0 });
  const gone = await chat.admin.call("GET", "/api/providers/nope/usage");
  expect(gone.status).toBe(404);
});
