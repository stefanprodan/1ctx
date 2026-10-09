// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The anthropic wire through the composed app, on the recorded streams:
// the agent keeps the catalog's output cap, a tool round's thinking is
// stored and sent back with its signature, a refused replay is forgotten
// for the session, a summary on a model that always thinks goes at low
// with room to think, and a turn is priced at the model's rates.

import { describe, expect, test } from "bun:test";
import {
  modelPrice,
  type ReasoningDetail,
} from "../../src/server/providers/index.ts";
import {
  type Answer,
  anthropicFetch,
  refusal,
  stream,
} from "../helpers/anthropic.ts";
import {
  ANTHROPIC_MODEL,
  type ChatApp,
  chatApp,
  tick,
} from "../helpers/chat.ts";

async function settle(chat: ChatApp, sessionId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (chat.app.sessions.byId(sessionId)?.status !== "running") return;
    chat.app.now.value += 200;
    await tick();
  }
  throw new Error(`chat ${sessionId} did not settle`);
}

async function anthropicChat(model?: string) {
  const fake = anthropicFetch();
  const chat = await chatApp({
    wire: "anthropic",
    fetcher: fake.fetcher,
    ...(model === undefined ? {} : { model }),
  });
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

const blocks = (body: Record<string, any>, type: string) =>
  (body.messages as { content: Record<string, any>[] }[])
    .flatMap((turn) => turn.content)
    .filter((block) => block.type === type);

const queue = (fake: ReturnType<typeof anthropicFetch>, ...answers: Answer[]) =>
  fake.queue.push(...answers);

describe("the anthropic wire in a chat", () => {
  test("the agent keeps the output cap and a tool round's thinking goes back signed", async () => {
    const { chat, fake } = await anthropicChat();
    try {
      const agent = chat.app.db
        .query<{ output_limit: number | null; listed_as: string }, [string]>(
          "select output_limit, listed_as from agents where id = ?",
        )
        .get(chat.agentId);
      expect(agent).toEqual({
        output_limit: 128_000,
        listed_as: ANTHROPIC_MODEL,
      });
      queue(
        fake,
        stream("chat-parallel-calls-handmade.sse"),
        stream("chat-tool-result.sse"),
      );
      const sessionId = await start(chat, "add them");
      expect(chat.app.sessions.lastSend(sessionId)).toMatchObject({
        status: "done",
        rounds: 2,
        toolCalls: 2,
      });
      const [first, second] = fake.bodies();
      expect(first).toMatchObject({
        model: ANTHROPIC_MODEL,
        max_tokens: 64_000,
        thinking: { type: "adaptive", display: "summarized" },
        stream: true,
      });
      expect(first!.system[0].cache_control).toEqual({ type: "ephemeral" });
      expect(first!.messages).toEqual([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "[casey] add them",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ]);
      // thinking, text, the two calls, then both results in one turn,
      // failed since no tool is named add
      const [thinking] = blocks(second!, "thinking");
      expect(Object.keys(thinking!).sort()).toEqual([
        "signature",
        "thinking",
        "type",
      ]);
      const turn = second!.messages[1].content.map(
        (block: { type: string }) => block.type,
      );
      expect(turn).toEqual(["thinking", "text", "tool_use", "tool_use"]);
      const results = blocks(second!, "tool_result");
      expect(results.map((r) => r.tool_use_id)).toEqual([
        "toolu_01QdWi9PSsQtwRC7CEX8v4XE",
        "toolu_013TTYdYdH9vDN2pN4MV62a6",
      ]);
      expect(results.every((r) => r.is_error === true)).toBe(true);
      expect(second!.messages).toHaveLength(3);
      expect(records(chat, sessionId)).toEqual(["thinking", "thinking"]);
      // the next turn sends both, each as stored
      queue(fake, stream("chat-thinking-off.sse"));
      await send(chat, sessionId, "thanks");
      expect(blocks(fake.bodies()[2]!, "thinking")).toHaveLength(2);
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  });

  test("a model's smaller output cap is the request's max_tokens", async () => {
    const { chat, fake } = await anthropicChat();
    try {
      chat.app.db
        .query("update agents set output_limit = 32000 where id = ?")
        .run(chat.agentId);
      queue(fake, stream("chat-thinking-off.sse"));
      await start(chat, "say ok");
      expect(fake.bodies()[0]!.max_tokens).toBe(32_000);
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  });

  test("a refused replay is forgotten for the session and the turn goes on", async () => {
    const { chat, fake } = await anthropicChat();
    try {
      queue(
        fake,
        stream("chat-parallel-calls-handmade.sse"),
        stream("chat-tool-result.sse"),
      );
      const sessionId = await start(chat, "add them");
      queue(
        fake,
        refusal("error-refused-replay-handmade.json"),
        stream("chat-thinking-off.sse"),
      );
      await send(chat, sessionId, "and again");
      const bodies = fake.bodies();
      expect(bodies).toHaveLength(4);
      expect(blocks(bodies[2]!, "thinking")).toHaveLength(2);
      expect(blocks(bodies[3]!, "thinking")).toEqual([]);
      expect(chat.app.sessions.lastSend(sessionId)).toMatchObject({
        status: "done",
      });
      expect(records(chat, sessionId)).toEqual([]);
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  });

  test("a summary on a model that always thinks goes at low with room to think", async () => {
    const { chat, fake } = await anthropicChat("claude-opus-5-5");
    try {
      queue(fake, stream("chat-thinking-off.sse"));
      const sessionId = await start(chat, "what did we decide");
      queue(fake, stream("chat-summary-opus-handmade.sse"));
      const res = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/compact`,
      );
      expect(res.status).toBeLessThan(300);
      await settle(chat, sessionId);
      const [turn, summary] = fake.bodies();
      // Off is never offered: the default is the model's own level
      expect(turn!.thinking).toEqual({
        type: "adaptive",
        display: "summarized",
      });
      expect(turn!).not.toHaveProperty("output_config");
      expect(summary!.thinking).toEqual({
        type: "adaptive",
        display: "summarized",
      });
      expect(summary!.output_config).toEqual({ effort: "low" });
      expect(summary!).not.toHaveProperty("tools");
      expect(summary!.max_tokens).toBeGreaterThanOrEqual(1024);
      expect(chat.app.sessions.messages(sessionId).at(-1)).toMatchObject({
        kind: "summary",
        status: "done",
      });
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  });

  test("a turn's usage row carries the cost at the model's rates", async () => {
    const { chat, fake } = await anthropicChat();
    try {
      queue(fake, stream("chat-cached-handmade.sse"));
      const sessionId = await start(chat, "which wires");
      const row = chat.app.db
        .query<{ cost: number | null }, [string]>(
          "select cost from usage where session_id = ?",
        )
        .get(sessionId)!;
      // 4 uncached in, 12,784 read and 51 written, 18 out
      const price = modelPrice("anthropic", ANTHROPIC_MODEL)!;
      expect(row.cost).toBeCloseTo(
        (4 * price.input +
          12_784 * price.cacheRead +
          51 * price.cacheWrite +
          18 * price.output) /
          1_000_000,
        12,
      );
      expect(row.cost).toBeGreaterThan(0);
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  });
});
