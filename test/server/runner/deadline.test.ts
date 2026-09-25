// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import type { PreparedRun } from "../../../src/server/runner/index.ts";
import { createAutomation } from "../../helpers/automations.ts";
import { chatApp, startChat, tick } from "../../helpers/chat.ts";

async function settle(
  app: Awaited<ReturnType<typeof chatApp>>["app"],
  sessionId: string,
) {
  for (let i = 0; i < 100; i++) {
    const session = app.sessions.byId(sessionId);
    if (session?.status !== "running") return session;
    await tick();
  }
  throw new Error("run did not settle");
}

describe("send deadlines", () => {
  test("stops a run at its deadline", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat);
    const pending = chat.scripted.next();
    const response = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/run`,
    );
    const detail = await response.json();
    const script = await pending;
    const messages = script.body.messages as { content: string }[];
    expect(messages[0]?.content).toContain(
      "This is a manual run of the daily-run automation, started at ",
    );
    expect(messages[0]?.content).toContain(
      "You run autonomously. Do not ask questions. Do the task and stop.",
    );
    // a run belongs to its project, so no person is named
    expect(messages[0]?.content).not.toContain("You talk to");

    chat.app.now.value += 600_000;
    const ended = await settle(chat.app, detail.session.id);
    expect(ended?.status).toBe("stopped");
    expect(chat.app.sessions.lastSend(detail.session.id)).toMatchObject({
      kind: "run",
      cause: "deadline",
      status: "stopped",
    });
    expect(script.aborted).toBeTrue();
    await chat.app.shutdown();
  });

  test("stops a chat turn at the send deadline", async () => {
    const chat = await chatApp();
    const started = await startChat(chat);
    expect(
      chat.app.runner.registry.get(started.sessionId)?.policy.deadlineMs,
    ).toBe(DEFAULT_LIMITS.sendDeadlineMs);
    // a model that keeps thinking out loud never trips the quiet timer
    const step = 60_000;
    for (let spent = 0; spent < DEFAULT_LIMITS.sendDeadlineMs - 1; ) {
      const ms = Math.min(step, DEFAULT_LIMITS.sendDeadlineMs - 1 - spent);
      started.script.reasoning("still thinking");
      await tick();
      chat.app.now.value += ms;
      spent += ms;
      await tick();
    }
    expect(chat.app.sessions.byId(started.sessionId)?.status).toBe("running");
    chat.app.now.value += 1;
    expect((await settle(chat.app, started.sessionId))?.status).toBe("stopped");
    expect(chat.app.sessions.lastSend(started.sessionId)).toMatchObject({
      kind: "chat",
      cause: "deadline",
      status: "stopped",
    });
    expect(started.script.aborted).toBeTrue();
    await chat.app.shutdown();
  });

  test("a chat that ends in time and an ended run keep their cause", async () => {
    const chat = await chatApp();
    const started = await startChat(chat);
    started.script.reply("done");
    await settle(chat.app, started.sessionId);
    chat.app.now.value += DEFAULT_LIMITS.sendDeadlineMs;
    await tick();
    expect(chat.app.sessions.lastSend(started.sessionId)?.cause).toBe("finish");

    const automation = await createAutomation(chat, { name: "ended-run" });
    const pending = chat.scripted.next();
    const response = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/run`,
    );
    const detail = await response.json();
    const script = await pending;
    script.reply("done");
    expect((await settle(chat.app, detail.session.id))?.status).toBe("done");
    chat.app.now.value += 600_000;
    await tick();
    expect(chat.app.sessions.lastSend(detail.session.id)?.cause).toBe("finish");
    await chat.app.shutdown();
  });

  test("a lowered run limit tightens a stored deadline", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { deadlineMs: 600_000 });
    const changed = await chat.admin.call("PUT", "/api/limits", {
      body: {
        values: { ...DEFAULT_LIMITS, runDeadlineMs: 60_000 },
      },
    });
    expect(changed.status).toBe(200);
    const pending = chat.scripted.next();
    const response = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/run`,
    );
    const detail = await response.json();
    const script = await pending;

    expect(
      chat.app.runner.registry.get(detail.session.id)?.policy.deadlineMs,
    ).toBe(60_000);
    script.reply("done");
    await settle(chat.app, detail.session.id);
    await chat.app.shutdown();
  });

  test("abandon frees a reservation whose transaction rolls back", async () => {
    const chat = await chatApp();
    const user = chat.app.users.byId(chat.memberId)!;
    const project = chat.app.projects.byId(chat.projectId)!;
    const agent = chat.app.agents.byId(chat.agentId)!;
    const holder: { prepared: PreparedRun | null } = { prepared: null };
    try {
      transact(chat.app.db, () => {
        holder.prepared = chat.app.runner.startRun({
          source: "manual",
          automation: {
            id: "auto",
            name: "rolled-back",
            tz: "UTC",
            ownMemory: false,
            memoryGuidance: "",
            disabledCapabilities: [],
          },
          instructions: "check",
          dueAt: chat.app.now.value,
          receivedAt: chat.app.now.value,
          key: null,
          deadlineMs: null,
          user,
          project,
          agent,
        });
        throw new Error("rollback");
      });
    } catch {
      holder.prepared?.abandon();
    }
    expect(chat.app.runner.registry.size).toBe(0);
    expect(chat.app.sessions.count(chat.projectId)).toBe(0);
    await chat.app.shutdown();
  });
});
