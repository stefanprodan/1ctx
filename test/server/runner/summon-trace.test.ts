// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A bash call that writes docs keeps their paths on its tool row, a
// summoned agent reads them in the trace, a delete saves nothing and a
// fork copies the paths.

import { describe, expect, test } from "bun:test";
import { TRACE_HEADING } from "../../../src/server/runner/trace.ts";
import { settleRun } from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  FLASH,
  type Script,
  startChat,
  tick,
  waitScript,
} from "../../helpers/chat.ts";

type WireMessage = { role: string; content: string | null };

const users = (script: Script) =>
  (script.body.messages as WireMessage[])
    .filter((message) => message.role === "user")
    .map((message) => message.content);

async function free(chat: ChatApp, sessionId: string) {
  await settleRun(chat, sessionId);
  for (let i = 0; i < 400; i++) {
    if (chat.app.runner.registry.get(sessionId) === null) return;
    await tick();
  }
  throw new Error("the lock was not let go");
}

async function turn(chat: ChatApp, sessionId: string, message: string) {
  await free(chat, sessionId);
  const count = chat.scripted.scripts.length;
  const response = await chat.member.call(
    "POST",
    `/api/sessions/${sessionId}/messages`,
    { body: { message } },
  );
  expect(response.status).toBe(201);
  return waitScript(chat.scripted, count + 1);
}

// one bash round, then the answer
async function bashRound(
  chat: ChatApp,
  script: Script,
  command: string,
  reply: string,
) {
  const count = chat.scripted.scripts.length;
  script.toolRound([
    { id: `b${count}`, name: "bash", arguments: JSON.stringify({ command }) },
  ]);
  script.end();
  (await waitScript(chat.scripted, count + 1)).reply(reply);
}

const saved = (chat: ChatApp, sessionId: string) =>
  chat.app.sessions
    .messages(sessionId)
    .filter((row) => row.kind === "tool")
    .map((row) => row.saved);

const WRITE = 'F=/knowledge/x.md\necho pods > "$F"\necho b > /knowledge/y.md';
const LINE = "bash F=/knowledge/x.md ok saved 2 files in /knowledge/";
const WROTE = {
  paths: ["/knowledge/x.md", "/knowledge/y.md"],
  count: 2,
  dir: "/knowledge",
};

describe("saved paths", () => {
  test("a summoned agent reads the docs a call wrote; a delete saves none", async () => {
    const chat = await chatApp();
    try {
      await chat.makeAgent({ name: "checker", model: FLASH });
      const { sessionId, script } = await startChat(chat, "note the pods");
      await bashRound(chat, script, WRITE, "noted");
      await free(chat, sessionId);
      expect(saved(chat, sessionId)).toEqual([WROTE]);

      const summoned = await turn(chat, sessionId, "@checker look");
      expect(users(summoned)).toContain(`${TRACE_HEADING}\n${LINE}`);
      summoned.reply("fine");

      const removed = await turn(chat, sessionId, "drop y");
      await bashRound(chat, removed, "rm /knowledge/y.md", "dropped");
      await free(chat, sessionId);
      expect(saved(chat, sessionId)).toEqual([WROTE, null]);

      const rows = chat.app.sessions.messages(sessionId);
      const forked = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/fork`,
        { body: { messageId: rows.at(-1)!.id, agentId: chat.agentId } },
      );
      expect(forked.status).toBe(201);
      const fork = (await forked.json()).session.id as string;
      expect(saved(chat, fork)).toEqual(saved(chat, sessionId));
      const again = await turn(chat, fork, "@checker again");
      expect(users(again)).toContain(`${TRACE_HEADING}\n${LINE}`);
      expect(users(again)).toContain(
        `${TRACE_HEADING}\nbash rm /knowledge/y.md ok`,
      );
      again.reply("same");
      await free(chat, fork);
    } finally {
      await chat.app.shutdown();
    }
  });
});
