// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { WeekUsageResponse } from "../../src/shared/api/usage.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  startChat,
  tick,
} from "../helpers/chat.ts";

const DAY_MS = 86_400_000;

async function finish(
  chat: ChatApp,
  script: Script,
  prompt: number,
  completion: number,
): Promise<void> {
  script.content("done");
  script.finish();
  script.usage({ prompt, completion });
  script.end();
  for (let i = 0; i < 100 && chat.app.runner.registry.size > 0; i++) {
    await tick();
  }
  expect(chat.app.runner.registry.size).toBe(0);
}

describe("GET /api/usage/week", () => {
  test("sums distinct visible sessions in the seven-day window", async () => {
    const chat = await chatApp();
    chat.app.now.value = 8 * DAY_MS;

    const old = await startChat(chat, "old");
    await finish(chat, old.script, 100, 50);

    chat.app.now.value += 7 * DAY_MS + 1;
    const first = await startChat(chat, "first");
    await finish(chat, first.script, 11, 5);
    const followUpPending = chat.scripted.next();
    const followUpRes = await chat.member.call(
      "POST",
      `/api/sessions/${first.sessionId}/messages`,
      { body: { message: "follow up" } },
    );
    expect(followUpRes.status).toBe(201);
    await finish(chat, await followUpPending, 13, 6);

    const second = await startChat(chat, "second");
    await finish(chat, second.script, 17, 7);

    const adminProject = chat.app.projects.personal(chat.adminId)!.id;
    const other = await startChat(
      chat,
      "other user's chat",
      chat.admin,
      adminProject,
    );
    await finish(chat, other.script, 1_000, 500);

    const res = await chat.member.call("GET", "/api/usage/week");
    expect(res.status).toBe(200);
    expect((await res.json()) as WeekUsageResponse).toEqual({
      since: chat.app.now.value - 7 * DAY_MS,
      sessions: 2,
      promptTokens: 41,
      completionTokens: 18,
    });
    expect(
      (await chat.member.call("GET", "/api/usage/week?extra=1")).status,
    ).toBe(400);

    await chat.app.shutdown();
  });
});
