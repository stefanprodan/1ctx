// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a router says about a round, from its frames to the reply row,
// the usage row, a fork and the download: kept only when it says
// something, and never read on the plain wire.

import { describe, expect, test } from "bun:test";
import type { Wire } from "../../../src/shared/words.ts";
import { type ChatApp, chatApp, startChat, tick } from "../../helpers/chat.ts";

const fixture = (name: string) =>
  Bun.file(
    new URL(`../../fixtures/providers/openrouter/${name}`, import.meta.url),
  ).text();

// the whole recorded stream through the runner, then the send's end
async function replay(wire: Wire, name: string) {
  const chat = await chatApp({ wire });
  const { script, sessionId } = await startChat(chat);
  script.sse(await fixture(name));
  script.end();
  for (let i = 0; i < 100 && chat.app.runner.live(sessionId); i++) {
    await tick();
  }
  const answer = chat.app.sessions
    .messages(sessionId)
    .find((row) => row.kind === "reply")!;
  const usage = chat.app.db
    .query<{ upstream: string | null; served_model: string | null }, [string]>(
      "select upstream, served_model from usage where session_id = ?",
    )
    .all(sessionId);
  return { chat, sessionId, answer, usage };
}

async function close(chat: ChatApp) {
  await chat.app.shutdown();
  chat.app.db.close();
}

describe("who served a round", () => {
  test("the upstream is kept, the model asked for and a plain stop are not", async () => {
    const { chat, answer, usage } = await replay(
      "openrouter",
      "chat-served.sse",
    );
    try {
      expect(answer.status).toBe("done");
      expect(answer.content).toBe("ok");
      expect(answer).toMatchObject({
        finishReason: "stop",
        upstream: "Wafer",
        servedModel: null,
        nativeFinish: null,
      });
      expect(usage).toEqual([{ upstream: "Wafer", served_model: null }]);
    } finally {
      await close(chat);
    }
  });

  test("a router's pick and a filter's native reason are kept and forked", async () => {
    const { chat, sessionId, answer, usage } = await replay(
      "openrouter",
      "chat-filtered.sse",
    );
    try {
      expect(answer).toMatchObject({
        content: "The first half of",
        finishReason: "content_filter",
        upstream: "Filterhost",
        servedModel: "vendor/picked-model",
        nativeFinish: "SAFETY",
      });
      expect(usage).toEqual([
        { upstream: "Filterhost", served_model: "vendor/picked-model" },
      ]);
      const markdown = await chat.member.call(
        "GET",
        `/api/sessions/${sessionId}/markdown?tz=UTC`,
      );
      expect(await markdown.text()).toContain(
        "cut by the provider's filter (SAFETY)",
      );
      const forked = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/fork`,
        { body: { messageId: answer.id, agentId: chat.agentId } },
      );
      expect(forked.status).toBe(201);
      const { session } = await forked.json();
      const copy = chat.app.sessions
        .messages(session.id)
        .find((row) => row.kind === "reply")!;
      expect(copy).toMatchObject({
        upstream: "Filterhost",
        servedModel: "vendor/picked-model",
        nativeFinish: "SAFETY",
      });
    } finally {
      await close(chat);
    }
  });

  test("a round stopped after its first frame still knows who served it", async () => {
    const chat = await chatApp({ wire: "openrouter" });
    try {
      const { script, sessionId } = await startChat(chat);
      const first = (await fixture("chat-served.sse")).split("\n\n")[0]!;
      script.sse(`${first}\n\n`);
      await tick();
      const stop = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/stop`,
      );
      expect(stop.status).toBeLessThan(300);
      for (let i = 0; i < 100 && chat.app.runner.live(sessionId); i++) {
        await tick();
      }
      const answer = chat.app.sessions
        .messages(sessionId)
        .find((row) => row.kind === "reply")!;
      expect(answer).toMatchObject({
        status: "stopped",
        content: "ok",
        upstream: "Wafer",
        servedModel: null,
      });
    } finally {
      await close(chat);
    }
  });

  test("a trailing frame that leaves the fields out keeps what came before", async () => {
    const chat = await chatApp({ wire: "openrouter" });
    try {
      const { script, sessionId } = await startChat(chat);
      const frame = (body: Record<string, unknown>) =>
        `data: ${JSON.stringify({ id: "gen-trailing", ...body })}\n\n`;
      script.sse(
        frame({
          model: "vendor/picked-model",
          provider: "Filterhost",
          choices: [
            {
              index: 0,
              delta: { content: "Cut here" },
              finish_reason: "content_filter",
              native_finish_reason: "SAFETY",
            },
          ],
        }),
      );
      script.sse(
        frame({
          choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      );
      script.end();
      for (let i = 0; i < 100 && chat.app.runner.live(sessionId); i++) {
        await tick();
      }
      const answer = chat.app.sessions
        .messages(sessionId)
        .find((row) => row.kind === "reply")!;
      expect(answer).toMatchObject({
        finishReason: "content_filter",
        upstream: "Filterhost",
        servedModel: "vendor/picked-model",
        nativeFinish: "SAFETY",
      });
    } finally {
      await close(chat);
    }
  });

  test("the plain wire keeps none of it", async () => {
    const { chat, answer, usage } = await replay(
      "openai-compatible",
      "chat-filtered.sse",
    );
    try {
      expect(answer).toMatchObject({
        finishReason: "content_filter",
        upstream: null,
        servedModel: null,
        // the native reason is the wire's own field, read on any wire
        nativeFinish: "SAFETY",
      });
      expect(usage).toEqual([{ upstream: null, served_model: null }]);
    } finally {
      await close(chat);
    }
  });
});
