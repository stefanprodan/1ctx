// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, spyOn, test } from "bun:test";
import * as tokenCount from "../../../src/server/lib/tokens.ts";
import { storeMcpDigest } from "../../../src/server/sessions/mcp.ts";
import { channelApp, localAt, messagesOf } from "../../helpers/channel.ts";
import { idle, setLimits, startChat } from "../../helpers/chat.ts";
import { frames, watch, watcher } from "../../helpers/socket.ts";

test.serial(
  "a watcher reads the meter on posts and turn boundaries, never work or restart envelopes",
  async () => {
    const { chat, channelId, post, summon, tool } = await channelApp();
    const meter = spyOn(chat.app.runner, "channelMeter");
    const query = spyOn(chat.app.db, "query");
    try {
      const conn = await watcher(chat);
      watch(chat, conn, channelId);
      expect(meter).toHaveBeenCalledTimes(1);
      meter.mockClear();
      await post("before the turn");
      expect(meter).toHaveBeenCalledTimes(1);
      meter.mockClear();
      const turn = await summon();
      expect(meter).toHaveBeenCalledTimes(2);
      const startFrames = frames(conn, "session").length;
      meter.mockClear();
      query.mockClear();
      let round = turn.script;
      for (const command of ["printf first", "printf second"]) {
        round = await tool(round, command);
      }
      const count = chat.scripted.scripts.length;
      round.content("looped provider output ".repeat(1000));
      round = await chat.scripted.reached(count + 1);
      expect(frames(conn, "restart")).toHaveLength(1);
      const work = frames(conn, "session").slice(startFrames);
      expect(work.some((frame) => frame.send === null)).toBe(true);
      expect(
        work.some((frame) =>
          frame.messages.some(
            (row) => row.kind === "tool" && row.status === "done",
          ),
        ),
      ).toBe(true);
      expect(work.every((frame) => frame.channelContext === undefined)).toBe(
        true,
      );
      expect(meter).not.toHaveBeenCalled();
      expect(
        query.mock.calls.filter(([sql]) => sql.includes("as firstSeq")),
      ).toHaveLength(0);
      await post("posted during work");
      expect(meter).toHaveBeenCalledTimes(1);
      meter.mockClear();
      round.reply("finished");
      await idle(chat.app);
      expect(meter).toHaveBeenCalledTimes(1);
      expect(
        frames(conn, "session").at(-1)?.channelContext?.tokens,
      ).toBeGreaterThan(0);

      await post("stream ".repeat(2000));
      await setLimits(chat, {
        channelStreamTokens: 1000,
        channelDropTokens: 1000,
      });
      meter.mockClear();
      const next = await summon();
      expect(meter).toHaveBeenCalledTimes(2);
      expect(chat.app.sessions.byId(channelId)?.droppedSeq).toBeGreaterThan(0);
      expect(frames(conn, "session").at(-1)?.channelContext).toEqual(
        chat.app.runner.channelMeter(channelId),
      );
      next.script.reply("done");
      await idle(chat.app);
      chat.app.socket.close(conn);
    } finally {
      meter.mockRestore();
      query.mockRestore();
      await chat.app.shutdown();
    }
  },
);

test.serial(
  "a channel frame counts once for several watchers, and unchanged reads count nothing",
  async () => {
    const { chat, channelId, post, detail } = await channelApp();
    const counted = spyOn(tokenCount, "tokens");
    const query = spyOn(chat.app.db, "query");
    try {
      const conns = await Promise.all(
        Array.from({ length: 3 }, () => watcher(chat)),
      );
      for (const conn of conns) watch(chat, conn, channelId);
      counted.mockClear();
      query.mockClear();
      await post("one shared post");
      expect(counted).toHaveBeenCalledTimes(1);
      expect(
        query.mock.calls.filter(([sql]) => sql.includes("as firstSeq")),
      ).toHaveLength(1);
      const meter = frames(conns[0]!, "session").at(-1)!.channelContext;
      expect(meter?.tokens).toBeGreaterThan(0);
      for (const conn of conns) {
        expect(frames(conn, "session").at(-1)?.channelContext).toEqual(meter);
        watch(chat, conn, channelId);
        expect(frames(conn, "watched").at(-1)?.channelContext).toEqual(meter);
      }
      expect((await detail()).channelContext).toEqual(meter);
      expect((await detail()).channelContext).toEqual(meter);
      expect(counted).toHaveBeenCalledTimes(1);
      expect(
        query.mock.calls.filter(([sql]) => sql.includes("as firstSeq")),
      ).toHaveLength(1);
      for (const conn of conns) chat.app.socket.close(conn);
    } finally {
      counted.mockRestore();
      query.mockRestore();
      await chat.app.shutdown();
    }
  },
);

test.serial(
  "meter invalidation follows revision and dropped mark, not the live budget",
  async () => {
    const { chat, channelId, post } = await channelApp();
    try {
      await post("first post");
      const first = chat.app.sessions.messages(channelId)[0]!;
      const meter = () => chat.app.runner.channelMeter(channelId);
      const counted = spyOn(tokenCount, "tokens");
      try {
        const before = meter();
        expect(counted).toHaveBeenCalledTimes(1);
        expect(meter()).toEqual(before);
        expect(counted).toHaveBeenCalledTimes(1);
        await post("second post");
        const both = meter();
        expect(both.tokens).toBeGreaterThan(before.tokens);
        expect(counted).toHaveBeenCalledTimes(3);
        chat.app.db
          .query("update sessions set dropped_seq = ? where id = ?")
          .run(first.seq + 1, channelId);
        const dropped = meter();
        expect(dropped.tokens).toBeLessThan(both.tokens);
        expect(counted).toHaveBeenCalledTimes(4);
        await setLimits(chat, { channelStreamTokens: 200_000 });
        expect(meter()).toEqual({ ...dropped, budget: 200_000 });
        expect(counted).toHaveBeenCalledTimes(4);
      } finally {
        counted.mockRestore();
      }
    } finally {
      await chat.app.shutdown();
    }
  },
);

test("a meter read inside a rolled-back transaction never poisons the cache", async () => {
  const { chat, channelId, post } = await channelApp();
  try {
    await post("original");
    const meter = () => chat.app.runner.channelMeter(channelId);
    const before = meter();
    const edit = (text: string) => {
      chat.app.db
        .query("update messages set content = ? where session_id = ?")
        .run(text, channelId);
      chat.app.db
        .query("update sessions set revision = revision + 1 where id = ?")
        .run(channelId);
    };
    expect(() =>
      chat.app.db.transaction(() => {
        edit("temporary ".repeat(100));
        expect(meter().tokens).toBeGreaterThan(before.tokens);
        throw new Error("rollback");
      })(),
    ).toThrow("rollback");
    edit("committed ".repeat(10));
    const after = meter();
    expect(after.tokens).toBeGreaterThan(before.tokens);
    expect(after.tokens).toBe(
      tokenCount.tokens(
        JSON.stringify([
          { role: "user", content: "committed ".repeat(10), name: "casey" },
        ]),
      ),
    );
  } finally {
    await chat.app.shutdown();
  }
});

test("a channel start reads its previous MCP digest only once", async () => {
  const { chat, summon, tool } = await channelApp();
  const previous = spyOn(chat.app.sessions, "lastMcpDigest");
  try {
    const turn = await summon();
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous.mock.calls[0]).toEqual([
      turn.send.sessionId,
      turn.send.id,
      chat.agentId,
    ]);
    expect(turn.send.mcpNote).toBe("");
    turn.script.reply("done");
    await idle(chat.app);
    const digest = { srv: { tools: { read: "hash" }, instructions: "" } };
    chat.app.db
      .query("update sends set mcp = ? where id = ?")
      .run(storeMcpDigest(chat.app.db, digest), turn.send.id);
    previous.mockClear();
    const next = await summon();
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous.mock.results[0]?.value).toEqual(digest);
    expect(next.send.mcpNote).toContain("- srv: no longer available");
    expect(messagesOf(next.script)[localAt(next.script)]?.content).toContain(
      next.send.mcpNote,
    );
    const round = await tool(next.script);
    expect(messagesOf(round)[localAt(round)]).toEqual(
      messagesOf(next.script)[localAt(next.script)],
    );
    expect(previous).toHaveBeenCalledTimes(1);
    round.reply("done again");
    await idle(chat.app);
  } finally {
    previous.mockRestore();
    await chat.app.shutdown();
  }
});

test("chat and channel watches read only the origin after the access check", async () => {
  const { chat, channelId } = await channelApp();
  try {
    const { sessionId, script } = await startChat(chat, "hello");
    script.reply("done");
    await idle(chat.app);
    const conn = await watcher(chat);
    const root = spyOn(chat.app.sessions, "root");
    const query = spyOn(chat.app.db, "query");
    try {
      for (const id of [sessionId, channelId]) {
        root.mockClear();
        query.mockClear();
        watch(chat, conn, id);
        expect(root).toHaveBeenCalledTimes(1);
        expect(
          query.mock.calls.filter(
            ([sql]) => sql === "select origin from sessions where id = ?",
          ),
        ).toHaveLength(1);
        const frame = frames(conn, "watched").at(-1)!;
        expect(frame.sessionId).toBe(id);
        if (id === sessionId) expect(frame.channelContext).toBeUndefined();
        else
          expect(frame.channelContext).toEqual({ tokens: 0, budget: 100_000 });
      }
    } finally {
      root.mockRestore();
      query.mockRestore();
      chat.app.socket.close(conn);
    }
  } finally {
    await chat.app.shutdown();
  }
});
