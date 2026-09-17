// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  VISUAL_EVERY_BYTES,
  VISUAL_EVERY_MS,
} from "../../../src/server/runner/round-visuals.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import { isVisualFrame } from "../../../src/shared/socket.ts";
import orders from "../../fixtures/providers/tool-call-order.json";
import { settleRun } from "../../helpers/automations.ts";
import { chatApp, startChat, tick, waitScript } from "../../helpers/chat.ts";
import { frames, watch, watcher } from "../../helpers/socket.ts";

describe("visual rounds", () => {
  test.serial(
    "coalesces at 100 ms, shares the stream sequence and snapshots sent prefixes",
    async () => {
      const chat = await chatApp();
      try {
        const { script, sessionId, detail } = await startChat(chat);
        const conn = await watcher(chat);
        const observer = await watcher(chat);
        watch(chat, conn, sessionId);
        script.content("Drawing.");
        script.toolCall({
          index: 5,
          name: "visualize",
          arguments: '{"html":"<p>\\ud83d',
        });
        await tick();
        script.toolCall({ index: 5, arguments: "\\ude80" });
        await tick();
        expect(frames(conn, "visual")).toEqual([]);
        chat.app.now.value += VISUAL_EVERY_MS - 1;
        await tick();
        expect(frames(conn, "visual")).toEqual([]);
        chat.app.now.value += 1;
        await tick();
        const first = frames(conn, "visual")[0]!;
        expect(isVisualFrame(first)).toBe(true);
        expect(first).toMatchObject({
          messageId: detail.messages[1].id,
          callIndex: 0,
          html: "<p>\ud83d\ude80",
          htmlAt: 0,
        });
        expect(first).not.toHaveProperty("title");
        const joined = await watcher(chat);
        watch(chat, joined, sessionId);
        expect(frames(joined, "watched")[0]?.live).toMatchObject({
          seq: first.seq,
          drafts: [
            {
              messageId: first.messageId,
              callIndex: 0,
              html: first.html,
            },
          ],
        });
        const snapshot: SessionDetail = await (
          await chat.member.call("GET", `/api/sessions/${sessionId}`)
        ).json();
        script.toolCall({
          index: 5,
          arguments: '</p>","title":"Launch"}',
        });
        await tick();
        chat.app.now.value += VISUAL_EVERY_MS;
        await tick();
        expect(frames(conn, "visual")[1]).toMatchObject({
          htmlAt: 5,
          html: "</p>",
          title: "Launch",
        });
        expect(snapshot.live?.drafts?.[0]?.html).toBe("<p>\ud83d\ude80");
        chat.app.now.value += 1000;
        script.content(" Ready.");
        await tick();
        const stream = conn.frames.filter(
          (f) => f.type === "visual" || f.type === "delta" || f.type === "html",
        );
        expect(stream.map((f) => f.seq)).toEqual(stream.map((_, i) => i + 1));
        expect(frames(conn, "html")).toHaveLength(1);
        expect(frames(observer, "visual")).toEqual([]);
        expect(frames(observer, "session").length).toBeGreaterThan(0);
        script.finish("tool_calls");
        script.end();
        const answer = await waitScript(chat.scripted, 2);
        expect(chat.app.runner.live(sessionId)?.drafts).toBeUndefined();
        const call = chat.app.sessions.message(first.messageId)?.toolCalls?.[0];
        expect(JSON.parse(call!.arguments)).toEqual({
          html: "<p>\ud83d\ude80</p>",
          title: "Launch",
        });
        answer.reply("Done.");
        await settleRun(chat, sessionId);
      } finally {
        await chat.app.shutdown();
      }
    },
  );

  test("flushes at exactly 4 KB without waiting for the timer", async () => {
    const chat = await chatApp();
    try {
      const { script, sessionId } = await startChat(chat);
      const conn = await watcher(chat);
      watch(chat, conn, sessionId);
      script.toolCall({
        name: "visualize",
        arguments: `{"title":"Size","html":"${"a".repeat(VISUAL_EVERY_BYTES - 1)}`,
      });
      await tick();
      expect(frames(conn, "visual")).toEqual([]);
      script.toolCall({ arguments: "b" });
      await tick();
      expect(frames(conn, "visual")).toHaveLength(1);
      expect(frames(conn, "visual")[0]?.html).toHaveLength(VISUAL_EVERY_BYTES);
      expect(frames(conn, "visual")[0]?.title).toBe("Size");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("sends a late title by itself after the fragment closed", async () => {
    const chat = await chatApp();
    try {
      const { script, sessionId } = await startChat(chat);
      const conn = await watcher(chat);
      watch(chat, conn, sessionId);
      script.toolCall({
        name: "visualize",
        arguments: '{"html":"<p>done</p>"',
      });
      await tick();
      chat.app.now.value += VISUAL_EVERY_MS;
      await tick();
      script.toolCall({ arguments: ',"title":"Late"}' });
      await tick();
      chat.app.now.value += VISUAL_EVERY_MS;
      await tick();
      expect(frames(conn, "visual")[1]).toMatchObject({
        html: "",
        htmlAt: 11,
        title: "Late",
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  for (const fixture of orders) {
    test(`draft indexes match stored calls: ${fixture.name}`, async () => {
      const chat = await chatApp();
      try {
        const { script, sessionId, detail } = await startChat(chat);
        const conn = await watcher(chat);
        watch(chat, conn, sessionId);
        for (const delta of fixture.deltas) {
          script.toolCall({ ...delta, arguments: delta.arguments ?? "" });
          await tick();
          chat.app.now.value += VISUAL_EVERY_MS;
          await tick();
        }
        script.finish("tool_calls");
        script.end();
        const answer = await waitScript(chat.scripted, 2);
        expect(
          chat.app.sessions.message(detail.messages[1].id)?.toolCalls,
        ).toEqual(fixture.calls);
        const drafts = frames(conn, "visual");
        expect(drafts.length).toBeGreaterThan(0);
        const prefixes = new Map<number, string>();
        for (const draft of drafts) {
          const previous = prefixes.get(draft.callIndex) ?? "";
          expect(draft.htmlAt).toBe(previous.length);
          const prefix = previous + draft.html;
          expect(
            JSON.parse(
              fixture.calls[draft.callIndex]!.arguments,
            ).html.startsWith(prefix),
          ).toBe(true);
          prefixes.set(draft.callIndex, prefix);
        }
        expect(chat.app.runner.live(sessionId)?.drafts).toBeUndefined();
        answer.reply("Done.");
      } finally {
        await chat.app.shutdown();
      }
    });
  }

  test("stops a duplicate-root draft and lets the stored call use the final value", async () => {
    const chat = await chatApp();
    try {
      const { script, sessionId, detail } = await startChat(chat);
      const conn = await watcher(chat);
      watch(chat, conn, sessionId);
      script.toolCall({
        name: "visualize",
        arguments: '{"title":"Duplicate","html":"<p>first',
      });
      await tick();
      chat.app.now.value += VISUAL_EVERY_MS;
      await tick();
      script.toolCall({ arguments: '</p>","html":"<p>last</p>"}' });
      await tick();
      chat.app.now.value += VISUAL_EVERY_MS;
      await tick();
      expect(frames(conn, "visual")).toHaveLength(1);
      expect(chat.app.runner.live(sessionId)?.drafts).toBeUndefined();
      script.finish("tool_calls");
      script.end();
      const answer = await waitScript(chat.scripted, 2);
      const visual = await chat.member.call(
        "GET",
        `/api/sessions/${sessionId}/messages/${detail.messages[1].id}/calls/0/visual`,
      );
      expect(await visual.json()).toEqual({
        title: "Duplicate",
        html: "<p>last</p>",
      });
      answer.reply("Done.");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("stops a draft at visualBytes and stores a failed tool with the reason", async () => {
    const chat = await chatApp();
    try {
      expect(
        (
          await chat.admin.call("PUT", "/api/limits", {
            body: { values: { ...DEFAULT_LIMITS, visualBytes: 16 * 1024 } },
          })
        ).status,
      ).toBe(200);
      const { script, sessionId } = await startChat(chat);
      const conn = await watcher(chat);
      watch(chat, conn, sessionId);
      script.toolCall({
        name: "visualize",
        arguments: `{"title":"Cap","html":"${"a".repeat(16 * 1024)}`,
      });
      await tick();
      expect(frames(conn, "visual")[0]?.html).toHaveLength(16 * 1024);
      script.toolCall({ arguments: 'b"}' });
      await tick();
      chat.app.now.value += VISUAL_EVERY_MS;
      await tick();
      expect(frames(conn, "visual")).toHaveLength(1);
      expect(chat.app.runner.live(sessionId)?.drafts).toBeUndefined();
      script.finish("tool_calls");
      script.end();
      const answer = await waitScript(chat.scripted, 2);
      expect(
        chat.app.sessions
          .messages(sessionId)
          .find((row) => row.kind === "tool"),
      ).toMatchObject({
        status: "failed",
        error: "Error: visual exceeds 16 KB",
      });
      answer.reply("Too large.");
    } finally {
      await chat.app.shutdown();
    }
  });
});
