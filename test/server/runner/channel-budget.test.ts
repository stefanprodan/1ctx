// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, spyOn, test } from "bun:test";
import { tokens } from "../../../src/server/lib/tokens.ts";
import { requestTokens } from "../../../src/server/providers/index.ts";
import { channelRead } from "../../../src/server/runner/channel-read.ts";
import {
  streamTurns,
  trimStream,
} from "../../../src/server/runner/channel-stream.ts";
import { request } from "../../../src/server/runner/context.ts";
import { compactsAt } from "../../../src/shared/compaction.ts";
import { channelApp, localAt, messagesOf } from "../../helpers/channel.ts";
import { idle, setLimits } from "../../helpers/chat.ts";
import { frames, watch, watcher } from "../../helpers/socket.ts";

describe("channel budget", () => {
  test("the exact work-room boundary includes the whole own tail's surplus", async () => {
    const { chat, summon, post } = await channelApp({ window: 262_144 });
    try {
      const a = await summon();
      a.script.reply("fits");
      await idle(chat.app);
      const b = await summon();
      const messages = messagesOf(b.script);
      const policy = b.send.policy;
      const question = {
        role: "user" as const,
        content: "@coder check this",
        name: "casey",
      };
      const head = requestTokens(
        policy.wire,
        request(policy, b.send.sessionId, [
          { role: "system", content: messages[0]!.content },
          { role: "user", content: messages[localAt(b.script)]!.content },
          question,
        ]),
      );
      const tail = requestTokens(policy.wire, {
        model: policy.model,
        thinking: false,
        messages: [
          question,
          { role: "assistant", content: "fits", model: policy.model },
        ],
      });
      const neutral = tokens(
        JSON.stringify([question, { role: "user", content: "[coder] fits" }]),
      );
      const surplus = Math.max(0, tail - neutral);
      expect(surplus).toBeGreaterThan(0);
      const room =
        compactsAt(policy.contextLength, policy.limits.contextReserve)! -
        head -
        100_000 -
        surplus;
      b.script.reply("fits");
      await idle(chat.app);
      await setLimits(chat, { channelWorkTokens: room });
      const c = await summon();
      c.script.reply("fits");
      await idle(chat.app);
      await setLimits(chat, { channelWorkTokens: room + 1 });
      const refused = await post("@coder check this");
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: "the channel is too long for coder",
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a queued question before the new mark is restored only after its local line", async () => {
    const { chat, channelId, post, summon, detail } = await channelApp();
    try {
      await setLimits(chat, {
        channelStreamTokens: 1000,
        channelDropTokens: 1000,
      });
      const a = await summon();
      expect((await post("@coder dropped waiting question")).status).toBe(202);
      const pending = (await detail()).pending![0]!;
      const question = chat.app.sessions.message(pending.messageId)!;
      for (let i = 0; i < 6; i++) await post(`${i}: ${"alpha ".repeat(190)}`);
      const b = await summon("reviewer");
      expect((await detail()).session.droppedSeq).toBeGreaterThan(question.seq);
      b.script.reply("reviewer done");
      await b.send.drained;
      a.script.reply("coder done");
      await a.send.drained;
      const queued = await chat.scripted.reached(3);
      const messages = messagesOf(queued);
      expect(
        messages.filter((m) => m.content === question.content),
      ).toHaveLength(1);
      expect(messages[localAt(queued) + 1]?.content).toBe(question.content);
      expect(chat.app.sessions.pending.ofSession(channelId)).toEqual([]);
      queued.reply("queued done");
      await idle(chat.app);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the server counts the same stream for detail, watch and completed-turn frames", async () => {
    const { chat, channelId, detail, post, summon, tool } = await channelApp();
    try {
      expect((await detail()).channelContext).toEqual({
        tokens: 0,
        budget: 100_000,
      });
      const conn = await watcher(chat);
      watch(chat, conn, channelId);
      await post("A member's post");
      const count = tokens(
        JSON.stringify([
          { role: "user", content: "A member's post", name: "casey" },
        ]),
      );
      expect((await detail()).channelContext).toEqual({
        tokens: count,
        budget: 100_000,
      });
      expect(frames(conn, "session").at(-1)?.channelContext?.tokens).toBe(
        count,
      );
      watch(chat, conn, channelId);
      expect(frames(conn, "watched").at(-1)?.channelContext?.tokens).toBe(
        count,
      );
      const a = await summon();
      const before = (await detail()).channelContext!;
      const next = await tool(a.script);
      expect((await detail()).channelContext).toEqual(before);
      next.reply("finished answer");
      await idle(chat.app);
      const after = (await detail()).channelContext!;
      expect(after.tokens).toBeGreaterThan(before.tokens);
      expect(frames(conn, "session").at(-1)?.channelContext).toEqual(after);
      const stored = channelRead(chat.app.db, channelId, 0);
      expect(
        streamTurns(stored.rows, stored.turns).reduce(
          (sum, turn) => sum + turn.tokens,
          0,
        ),
      ).toBe(after.tokens);
      chat.app.socket.close(conn);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("crossing the budget drops whole turns in one deep transactional step", async () => {
    const { chat, channelId, post, summon, detail } = await channelApp();
    try {
      await setLimits(chat, {
        channelStreamTokens: 1000,
        channelDropTokens: 1000,
      });
      for (let i = 0; i < 6; i++) await post(`${i}: ${"alpha ".repeat(190)}`);
      const before = (await detail()).channelContext!.tokens;
      expect(before).toBeGreaterThan(1000);
      const a = await summon();
      const current = await detail();
      expect(current.channelContext!.tokens).toBeLessThanOrEqual(1000);
      expect(before - current.channelContext!.tokens).toBeGreaterThanOrEqual(
        1000,
      );
      expect(current.session.droppedSeq).toBeGreaterThan(1);
      const prefix = JSON.stringify(
        messagesOf(a.script).slice(0, localAt(a.script)),
      );
      expect(prefix).not.toContain("0: alpha");
      const mark = current.session.droppedSeq;
      a.script.reply("first answer");
      await idle(chat.app);
      const b = await summon("reviewer");
      expect((await detail()).session.droppedSeq).toBe(mark);
      b.script.reply("second answer");
      await idle(chat.app);
      expect(
        chat.app.sessions
          .messages(channelId)
          .some((row) => row.content.startsWith("0: alpha")),
      ).toBe(true);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an active turn whose post falls before the mark never reappears partially", async () => {
    const { chat, post, summon, detail, tool } = await channelApp();
    try {
      await setLimits(chat, {
        channelStreamTokens: 1000,
        channelDropTokens: 1000,
      });
      const a = await summon("coder", "old running post");
      const original = JSON.stringify(messagesOf(a.script));
      for (let i = 0; i < 6; i++) await post(`${i}: ${"alpha ".repeat(190)}`);
      const b = await summon("reviewer");
      expect((await detail()).session.droppedSeq).toBeGreaterThan(1);
      b.script.reply("reviewer done");
      await b.send.drained;
      const next = await tool(a.script);
      expect(messagesOf(next).slice(0, messagesOf(a.script).length)).toEqual(
        JSON.parse(original),
      );
      next.reply("old answer after the mark");
      await idle(chat.app);
      const c = await summon("reviewer");
      expect(JSON.stringify(c.script.body)).not.toContain(
        "old answer after the mark",
      );
      expect(JSON.stringify(c.script.body)).not.toContain("old running post");
      c.script.reply("done");
      await idle(chat.app);
    } finally {
      await chat.app.shutdown();
    }
  });

  test.each([null, 131_072, 262_143])(
    "refuses a context of %p before writing the post",
    async (window) => {
      const { chat, channelId, post } = await channelApp();
      try {
        chat.app.db
          .query("update agents set context_length = ? where id = ?")
          .run(window, chat.agentId);
        const response = await post("@coder check this");
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error:
            "the channel requires at least 262144 context tokens for coder",
        });
        expect(chat.app.sessions.messages(channelId)).toEqual([]);
        expect(chat.scripted.scripts).toEqual([]);
      } finally {
        await chat.app.shutdown();
      }
    },
  );

  test("the floor itself is admitted, but a budget leaving too little work room is refused", async () => {
    const { chat, channelId, summon, post } = await channelApp();
    try {
      chat.app.db
        .query("update agents set context_length = 262144 where id = ?")
        .run(chat.agentId);
      const a = await summon();
      a.script.reply("fits");
      await idle(chat.app);
      await setLimits(chat, { channelStreamTokens: 200_000 });
      const response = await post("@coder does not fit");
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "the channel is too long for coder",
      });
      expect(chat.app.runner.registry.inSession(channelId)).toEqual([]);
      expect(chat.app.sessions.pending.ofSession(channelId)).toMatchObject([
        { reason: "failed" },
      ]);
      expect(chat.scripted.scripts).toHaveLength(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a refused start rolls back the drop step, while keeping its already-written post", async () => {
    const { chat, channelId, post, detail } = await channelApp();
    try {
      chat.app.db
        .query("update agents set context_length = 262144 where id = ?")
        .run(chat.agentId);
      await setLimits(chat, {
        channelStreamTokens: 1000,
        channelDropTokens: 1000,
        channelWorkTokens: 1_000_000,
      });
      for (let i = 0; i < 6; i++) await post(`${i}: ${"alpha ".repeat(190)}`);
      const before = await detail();
      const response = await post("@coder cannot start");
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "the channel is too long for coder",
      });
      expect((await detail()).session.droppedSeq).toBe(
        before.session.droppedSeq,
      );
      expect(chat.app.sessions.messages(channelId).at(-1)?.content).toBe(
        "@coder cannot start",
      );
    } finally {
      await chat.app.shutdown();
    }
  });

  test("every context query seeks an index on a migrated database, without ANALYZE", async () => {
    const { chat, summon, tool, detail, post } = await channelApp();
    try {
      await setLimits(chat, {
        channelStreamTokens: 1000,
        channelDropTokens: 1000,
      });
      const query = spyOn(chat.app.db, "query");
      let sqls: string[];
      try {
        const a = await summon();
        (await tool(a.script)).reply("first");
        await idle(chat.app);
        const b = await summon();
        b.script.reply("second");
        await idle(chat.app);
        await post("alpha ".repeat(2000));
        const c = await summon();
        c.script.reply("after dropping");
        await idle(chat.app);
        await detail();
        sqls = [...new Set(query.mock.calls.map(([sql]) => sql))].filter(
          (sql) =>
            sql.includes("as firstSeq") ||
            sql.includes("as details") ||
            sql.includes("as chars") ||
            sql.includes("dropped_seq"),
        );
      } finally {
        query.mockRestore();
      }
      expect(sqls.length).toBeGreaterThanOrEqual(5);
      expect(
        sqls.some((sql) => sql.startsWith("update sessions set dropped_seq")),
      ).toBe(true);
      for (const sql of sqls) {
        const params = Array.from(
          { length: sql.match(/\?/g)?.length ?? 0 },
          () => null,
        );
        const plan = chat.app.db
          .query<{ detail: string }, null[]>(`explain query plan ${sql}`)
          .all(...params)
          .map((r) => r.detail);
        expect({ sql, plan }).toMatchObject({ plan: expect.any(Array) });
        expect(
          plan.some((line) =>
            /^SCAN (?:TABLE )?(messages|sessions|sends|first)\b/.test(line),
          ),
        ).toBe(false);
        expect(plan.some((line) => /^SEARCH /.test(line))).toBe(true);
      }
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a single over-budget post can drop the whole stream without splitting the post", async () => {
    const { chat, channelId, post } = await channelApp();
    try {
      await post("word ".repeat(2000));
      const read = channelRead(chat.app.db, channelId, 0);
      const parts = streamTurns(read.rows, read.turns);
      const trimmed = trimStream(parts, 1000, 1000);
      expect(trimmed.kept).toEqual([]);
      expect(trimmed.tokens).toBe(0);
      expect(trimmed.from).toBe(2);
      expect(trimmed.dropped).toBe(parts[0]!.tokens);
    } finally {
      await chat.app.shutdown();
    }
  });
});
