// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { MAX_REPLY_BYTES } from "../../../src/server/runner/round.ts";
import { VISUAL_EVERY_MS } from "../../../src/server/runner/round-visuals.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import { chatApp, startChat, tick, waitScript } from "../../helpers/chat.ts";
import { frames, watch, watcher } from "../../helpers/socket.ts";

const partial = '{"title":"Drawing","html":"<p>partial';

describe("visual draft gates", () => {
  for (const disabled of [false, true]) {
    test(
      disabled ? "no draft for a disabled tool" : "no draft for another name",
      async () => {
        const chat = await chatApp();
        try {
          if (disabled) {
            await chat.admin.call("PATCH", "/api/tools/visualize", {
              body: { enabled: false },
            });
          }
          const { script, sessionId } = await startChat(chat);
          const conn = await watcher(chat);
          watch(chat, conn, sessionId);
          script.toolCall({
            name: disabled ? "visualize" : "webfetch",
            arguments: partial,
          });
          await tick();
          chat.app.now.value += VISUAL_EVERY_MS;
          await tick();
          expect(frames(conn, "visual")).toEqual([]);
          expect(chat.app.runner.live(sessionId)?.drafts).toBeUndefined();
        } finally {
          await chat.app.shutdown();
        }
      },
    );
  }

  test("the offered snapshot survives an admin switching off visualize", async () => {
    const chat = await chatApp();
    try {
      const { script, sessionId } = await startChat(chat);
      const conn = await watcher(chat);
      watch(chat, conn, sessionId);
      await chat.admin.call("PATCH", "/api/tools/visualize", {
        body: { enabled: false },
      });
      script.toolCall({ name: "visualize", arguments: partial });
      await tick();
      chat.app.now.value += VISUAL_EVERY_MS;
      await tick();
      expect(frames(conn, "visual")).toHaveLength(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an answer-only round emits no drafts", async () => {
    const chat = await chatApp();
    try {
      const { script, sessionId } = await startChat(chat);
      const active = chat.app.runner.registry.get(sessionId)!;
      active.policy.limits.rounds = 2;
      script.toolRound([{ name: "datetime", id: "time", arguments: "{}" }]);
      script.end();
      const answer = await waitScript(chat.scripted, 2);
      expect(answer.body.tool_choice).toBe("none");
      const conn = await watcher(chat);
      watch(chat, conn, sessionId);
      answer.toolCall({ name: "visualize", arguments: partial });
      await tick();
      chat.app.now.value += VISUAL_EVERY_MS;
      await tick();
      expect(frames(conn, "visual")).toEqual([]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a memory phase emits no drafts although its main round offered visualize", async () => {
    const chat = await chatApp();
    try {
      const automation = await createAutomation(chat, { ownMemory: true });
      const { sessionId, main } = await startRun(chat, automation.id);
      const active = chat.app.runner.registry.get(sessionId)!;
      expect(active.policy.offered.tools.map((tool) => tool.name)).toContain(
        "visualize",
      );
      main.reply("Done.");
      const memory = await waitScript(chat.scripted, 2);
      expect(active.phase).toBe("memory");
      const conn = await watcher(chat);
      watch(chat, conn, sessionId);
      memory.toolCall({ name: "visualize", arguments: partial });
      await tick();
      chat.app.now.value += VISUAL_EVERY_MS;
      await tick();
      expect(frames(conn, "visual")).toEqual([]);
      expect(chat.app.runner.live(sessionId)?.drafts).toBeUndefined();
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a compact round emits no drafts", async () => {
    const chat = await chatApp();
    try {
      const { script, sessionId } = await startChat(chat);
      script.reply("An answer to summarize.");
      await settleRun(chat, sessionId);
      const res = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/compact`,
      );
      expect(res.status).toBe(200);
      const compact = await waitScript(chat.scripted, 2);
      const conn = await watcher(chat);
      watch(chat, conn, sessionId);
      compact.toolCall({ name: "visualize", arguments: partial });
      await tick();
      chat.app.now.value += VISUAL_EVERY_MS;
      await tick();
      expect(frames(conn, "visual")).toEqual([]);
      expect(chat.app.runner.live(sessionId)?.drafts).toBeUndefined();
    } finally {
      await chat.app.shutdown();
    }
  });

  for (const name of ["visualize", "datetime", "unknown"]) {
    test(`${name} argument bytes count with content and reasoning toward the reply cap`, async () => {
      const chat = await chatApp();
      try {
        const { script, sessionId, detail } = await startChat(chat);
        script.content("12345");
        script.reasoning("12345");
        const half = MAX_REPLY_BYTES / 2;
        script.toolCall({ name, arguments: "x".repeat(half) });
        script.toolCall({ arguments: "x".repeat(half - 10) });
        await tick();
        await tick();
        expect(chat.app.sessions.send(detail.send.id)?.status).toBe("running");
        script.toolCall({ arguments: "x" });
        await settleRun(chat, sessionId);
        expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
          status: "failed",
          cause: "failure",
          error: "the reply exceeded 1 MB",
        });
        expect(
          chat.app.sessions.message(detail.messages[1].id)?.toolCalls,
        ).toBeNull();
        expect(script.aborted).toBe(true);
      } finally {
        await chat.app.shutdown();
      }
    });
  }

  for (const cause of ["stop", "failure"] as const) {
    test(`${cause} keeps only the watched preview and cancels queued draft frames`, async () => {
      const chat = await chatApp();
      try {
        const { script, sessionId, detail } = await startChat(chat);
        const conn = await watcher(chat);
        watch(chat, conn, sessionId);
        script.toolCall({ name: "visualize", arguments: partial });
        await tick();
        chat.app.now.value += VISUAL_EVERY_MS;
        await tick();
        expect(frames(conn, "visual")).toHaveLength(1);
        script.toolCall({ arguments: " queued" });
        await tick();
        if (cause === "stop") {
          await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
        } else {
          script.end();
        }
        await settleRun(chat, sessionId);
        const count = frames(conn, "visual").length;
        chat.app.now.value += 1000;
        await tick();
        expect(frames(conn, "visual")).toHaveLength(count);
        expect(chat.app.runner.live(sessionId)).toBeNull();
        expect(chat.app.sessions.message(detail.messages[1].id)).toMatchObject({
          status: cause === "stop" ? "stopped" : "failed",
          toolCalls: null,
        });
        const fresh = await watcher(chat);
        watch(chat, fresh, sessionId);
        expect(frames(fresh, "watched")[0]?.live).toBeNull();
        const res = await chat.member.call(
          "POST",
          `/api/sessions/${sessionId}/regenerate`,
        );
        expect(res.status).toBe(201);
        const next = await waitScript(chat.scripted, 2);
        chat.app.now.value += 1000;
        await tick();
        expect(frames(conn, "visual")).toHaveLength(count);
        expect(chat.app.sessions.message(detail.messages[1].id)).toBeNull();
        next.reply("Replaced.");
      } finally {
        await chat.app.shutdown();
      }
    });
  }
});
