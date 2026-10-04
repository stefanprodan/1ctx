// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The azure wire through the composed app, on the recorded streams: a
// tool round's reasoning stored and sent back on the next request, a
// refused blob forgotten for the session, and a summary on a model that
// cannot stop thinking, which comes back cut with no text.

import { describe, expect, test } from "bun:test";
import type { ReasoningDetail } from "../../src/server/providers/index.ts";
import { type Answer, azureFetch, refusal, stream } from "../helpers/azure.ts";
import { AZURE_MODEL, type ChatApp, chatApp, tick } from "../helpers/chat.ts";

async function settle(chat: ChatApp, sessionId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (chat.app.sessions.byId(sessionId)?.status !== "running") return;
    chat.app.now.value += 200;
    await tick();
  }
  throw new Error(`chat ${sessionId} did not settle`);
}

async function azureChat() {
  const fake = azureFetch();
  const chat = await chatApp({ wire: "azure", fetcher: fake.fetcher });
  return { chat, fake };
}

async function start(chat: ChatApp, message: string): Promise<string> {
  const res = await chat.member.call("POST", "/api/sessions", {
    body: { projectId: chat.projectId, agentId: chat.agentId, message },
  });
  expect(res.status).toBe(201);
  const sessionId = (await res.json()).session.id as string;
  await settle(chat, sessionId);
  return sessionId;
}

async function send(chat: ChatApp, sessionId: string, message: string) {
  const res = await chat.member.call(
    "POST",
    `/api/sessions/${sessionId}/messages`,
    { body: { message } },
  );
  expect(res.status).toBeLessThan(300);
  await settle(chat, sessionId);
}

// every stored record of the session's replies, by type
function records(chat: ChatApp, sessionId: string): string[] {
  return chat.app.db
    .query<{ details: string | null }, [string]>(
      `select reasoning_details as details from messages
       where session_id = ? and kind = 'reply' order by seq`,
    )
    .all(sessionId)
    .flatMap((row) =>
      row.details === null
        ? []
        : (JSON.parse(row.details) as ReasoningDetail[]).map(
            (item) => item.type,
          ),
    );
}

const reasoningItems = (body: Record<string, any>) =>
  (body.input as { type?: string }[]).filter(
    (item) => item.type === "reasoning",
  );

const queue = (fake: ReturnType<typeof azureFetch>, ...answers: Answer[]) =>
  fake.queue.push(...answers);

describe("the azure wire in a chat", () => {
  test("a tool round's reasoning goes back on the next request, unchanged", async () => {
    const { chat, fake } = await azureChat();
    try {
      queue(
        fake,
        stream("chat-reasoning-tool.sse"),
        stream("chat-text-after-tool.sse"),
      );
      const sessionId = await start(chat, "find the prime");
      expect(chat.app.sessions.lastSend(sessionId)).toMatchObject({
        status: "done",
        rounds: 2,
        toolCalls: 1,
      });
      const [first, second] = fake.bodies();
      expect(first).toMatchObject({
        model: AZURE_MODEL,
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoning: { summary: "auto" },
        prompt_cache_key: sessionId,
      });
      expect(first!.input[1]).toEqual({
        role: "user",
        content: [{ type: "input_text", text: "[casey] find the prime" }],
      });
      expect(
        first!.tools.every((t: { strict: unknown }) => t.strict === false),
      ).toBe(true);
      // the three items as the stream gave them, no index, no id, then
      // the call and its result
      const replayed = second!.input.slice(2);
      expect(
        replayed.map((item: Record<string, unknown>) => item.type),
      ).toEqual([
        "reasoning",
        "reasoning",
        "reasoning",
        "function_call",
        "function_call_output",
      ]);
      for (const item of replayed.slice(0, 3)) {
        expect(Object.keys(item).sort()).toEqual([
          "encrypted_content",
          "summary",
          "type",
        ]);
      }
      expect(replayed[3]).toEqual({
        type: "function_call",
        call_id: "call_G61W63zk1acEY58UfBijDIH4",
        name: "weather",
        arguments: '{"city":"Y, France"}',
      });
      expect(records(chat, sessionId)).toEqual([
        "reasoning",
        "reasoning",
        "reasoning",
        "reasoning",
        "reasoning",
        "reasoning",
        "phase",
      ]);
      // the reasoning shows in the fold, its summaries apart
      const work = chat.app.sessions
        .messages(sessionId)
        .find((row) => row.kind === "reply" && row.slot === "work")!;
      expect(work.reasoning).toContain(
        "along the way.\n\n**Checking number properties**\n\n",
      );
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  });

  test("a refused blob is forgotten for the session and the turn goes on", async () => {
    const { chat, fake } = await azureChat();
    try {
      queue(
        fake,
        stream("chat-reasoning-tool.sse"),
        stream("chat-text-after-tool.sse"),
      );
      const sessionId = await start(chat, "find the prime");
      queue(
        fake,
        refusal("error-encrypted.json"),
        stream("chat-text-after-tool.sse"),
      );
      await send(chat, sessionId, "and again");
      const bodies = fake.bodies();
      expect(bodies).toHaveLength(4);
      expect(reasoningItems(bodies[2]!)).toHaveLength(6);
      expect(reasoningItems(bodies[3]!)).toEqual([]);
      // the answer's phase still goes back
      expect(bodies[3]!.input).toContainEqual(
        expect.objectContaining({ role: "assistant", phase: "final_answer" }),
      );
      expect(chat.app.sessions.lastSend(sessionId)).toMatchObject({
        status: "done",
      });
      // the first turn's reasoning is gone, its phase kept; the answer
      // after the refusal keeps its own
      expect(records(chat, sessionId)).toEqual([
        "phase",
        "reasoning",
        "reasoning",
        "reasoning",
        "phase",
      ]);
      queue(fake, stream("chat-text-after-tool.sse"));
      await send(chat, sessionId, "once more");
      expect(reasoningItems(fake.bodies()[4]!)).toHaveLength(3);
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  });

  test("a summary on a model that cannot stop thinking goes at low and a cut one fails", async () => {
    const { chat, fake } = await azureChat();
    try {
      queue(fake, stream("chat-text-after-tool.sse"));
      const sessionId = await start(chat, "what did we decide");
      queue(
        fake,
        refusal("error-effort-none.json"),
        stream("incomplete-reasoning-only.sse"),
      );
      const res = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/compact`,
      );
      expect(res.status).toBeLessThan(300);
      await settle(chat, sessionId);
      const [, summary, again] = fake.bodies();
      expect(summary!.reasoning).toEqual({ effort: "none" });
      expect(summary!).not.toHaveProperty("tools");
      expect(typeof summary!.max_output_tokens).toBe("number");
      expect(again!.reasoning).toEqual({ effort: "low", summary: "auto" });
      const rows = chat.app.sessions.messages(sessionId);
      expect(rows.at(-1)).toMatchObject({
        kind: "summary",
        status: "failed",
        error: "the summary came back empty",
      });
      // the old context stays: the next turn starts from the history
      queue(fake, stream("chat-text-after-tool.sse"));
      await send(chat, sessionId, "next");
      const next = fake.bodies().at(-1)!;
      expect(next.input[1]).toEqual({
        role: "user",
        content: [{ type: "input_text", text: "[casey] what did we decide" }],
      });
      // a default round leaves the level to the model
      expect(next.reasoning).toEqual({ summary: "auto" });
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  });
});
