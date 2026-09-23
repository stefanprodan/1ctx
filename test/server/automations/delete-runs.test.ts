// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createAutomation } from "../../helpers/automations.ts";
import { type ChatApp, chatApp, startChat, tick } from "../../helpers/chat.ts";

// a manual run of the automation, answered and settled
async function ran(chat: ChatApp, automationId: string): Promise<string> {
  const pending = chat.scripted.next();
  const started = await chat.member.call(
    "POST",
    `/api/automations/${automationId}/run`,
  );
  const id = (await started.json()).session.id as string;
  (await pending).reply("done");
  for (let i = 0; i < 100; i++) {
    if (chat.app.sessions.byId(id)?.status !== "running") return id;
    await tick();
  }
  throw new Error("run did not settle");
}

const usageRows = (chat: ChatApp, sessionId: string) =>
  chat.app.db
    .query<{ n: number }, [string]>(
      "select count(*) as n from usage where session_id = ?",
    )
    .get(sessionId)!.n;

describe("deleting an automation with its runs", () => {
  test("takes every run and its usage, never a chat", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat);
    const runs = [
      await ran(chat, automation.id),
      await ran(chat, automation.id),
    ];
    const { sessionId: chatId, script } = await startChat(chat);
    script.reply("hi");
    for (let i = 0; i < 100; i++) {
      if (chat.app.sessions.byId(chatId)?.status !== "running") break;
      await tick();
    }
    expect(usageRows(chat, runs[0]!)).toBeGreaterThan(0);

    for (const query of ["runs=keep", "runs=delete&runs=delete", "other=1"]) {
      const refused = await chat.member.call(
        "DELETE",
        `/api/automations/${automation.id}?${query}`,
      );
      expect(refused.status).toBe(400);
    }
    expect(chat.app.automations.byId(automation.id)).not.toBeNull();

    const gone = await chat.member.call(
      "DELETE",
      `/api/automations/${automation.id}?runs=delete`,
    );
    expect(gone.status).toBe(204);
    expect(chat.app.automations.byId(automation.id)).toBeNull();
    for (const id of runs) {
      expect(chat.app.sessions.byId(id)).toBeNull();
      expect(usageRows(chat, id)).toBe(0);
    }
    expect(chat.app.sessions.byId(chatId)).not.toBeNull();
    expect(usageRows(chat, chatId)).toBeGreaterThan(0);
    await chat.app.shutdown();
  });

  test("keeps the runs without it, and refuses while one runs", async () => {
    const chat = await chatApp();
    const kept = await createAutomation(chat);
    const run = await ran(chat, kept.id);
    expect(
      (await chat.member.call("DELETE", `/api/automations/${kept.id}`)).status,
    ).toBe(204);
    expect(chat.app.sessions.byId(run)?.automationId).toBeNull();

    const busy = await createAutomation(chat);
    const pending = chat.scripted.next();
    const started = await chat.member.call(
      "POST",
      `/api/automations/${busy.id}/run`,
    );
    const running = (await started.json()).session.id as string;
    const script = await pending;
    expect(
      (
        await chat.member.call(
          "DELETE",
          `/api/automations/${busy.id}?runs=delete`,
        )
      ).status,
    ).toBe(409);
    expect(chat.app.sessions.byId(running)).not.toBeNull();
    script.reply("done");
    for (let i = 0; i < 100; i++) {
      if (chat.app.sessions.byId(running)?.status !== "running") break;
      await tick();
    }
    await chat.app.shutdown();
  });
});
