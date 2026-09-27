// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  KNOWLEDGE,
  KNOWLEDGE_OFF_LINE,
} from "../../../src/shared/capabilities.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import { createAutomation, startRun } from "../../helpers/automations.ts";
import { chatApp, tick, waitScript } from "../../helpers/chat.ts";

async function settled(chat: Awaited<ReturnType<typeof chatApp>>, id: string) {
  for (let i = 0; i < 200; i++) {
    if (chat.app.sessions.byId(id)?.status !== "running") return;
    await tick();
  }
  throw new Error("send did not settle");
}

describe("the chat's knowledge switch", () => {
  test("keeps bash, drops the block, adds the line, and an enable undoes it", async () => {
    const chat = await chatApp();
    try {
      const agents = await chat.member.call(
        "GET",
        `/api/projects/${chat.projectId}/agents`,
      );
      expect((await agents.json()).capabilities).toContain(KNOWLEDGE);
      const response = await chat.member.call("POST", "/api/sessions", {
        body: {
          projectId: chat.projectId,
          agentId: chat.agentId,
          message: "hello",
          capabilities: { disable: [KNOWLEDGE] },
        },
      });
      expect(response.status).toBe(201);
      const detail = (await response.json()) as SessionDetail;
      expect(detail.session.disabledCapabilities).toEqual(["knowledge"]);
      const script = await waitScript(chat.scripted, 1);
      const active = chat.app.runner.registry.get(detail.session.id)!;
      expect(active.policy.offered.knowledge).toBe(false);
      expect(active.policy.offered.tools.map((tool) => tool.name)).toContain(
        "bash",
      );
      const prompt = (script.body.messages as { content: string }[])[0]!
        .content;
      expect(prompt).toContain(KNOWLEDGE_OFF_LINE);
      expect(prompt).not.toContain("knowledge base");
      script.reply("done");
      await settled(chat, detail.session.id);
      const sent = await chat.member.call(
        "POST",
        `/api/sessions/${detail.session.id}/messages`,
        { body: { message: "again", capabilities: { enable: [KNOWLEDGE] } } },
      );
      expect(sent.status).toBe(201);
      const second = await waitScript(chat.scripted, 2);
      const again = chat.app.runner.registry.get(detail.session.id)!;
      expect(again.policy.offered.knowledge).toBe(true);
      const text = (second.body.messages as { content: string }[])[0]!.content;
      expect(text).not.toContain(KNOWLEDGE_OFF_LINE);
      expect(text).toContain("knowledge base");
      second.reply("done");
      await settled(chat, detail.session.id);
    } finally {
      await chat.app.shutdown();
    }
  });
  test("a task run gets the docs off and a fork of it keeps them off", async () => {
    const chat = await chatApp();
    try {
      const automation = await createAutomation(chat, {
        disabledCapabilities: [KNOWLEDGE],
      });
      const run = await startRun(chat, automation.id);
      const policy = chat.app.runner.registry.get(run.sessionId)!.policy;
      expect(policy.offered.knowledge).toBe(false);
      const prompt = (run.main.body.messages as { content: string }[])[0]!
        .content;
      expect(prompt).toContain(KNOWLEDGE_OFF_LINE);
      expect(prompt).not.toContain("knowledge base");
      run.main.reply("done");
      await settled(chat, run.sessionId);
      const reply = chat.app.sessions
        .messages(run.sessionId)
        .findLast((message) => message.kind === "reply")!;
      const fork = await chat.member.call(
        "POST",
        `/api/sessions/${run.sessionId}/fork`,
        { body: { messageId: reply.id, agentId: chat.agentId } },
      );
      expect(fork.status).toBe(201);
      expect((await fork.json()).session.disabledCapabilities).toEqual([
        KNOWLEDGE,
      ]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("regenerate keeps the docs off", async () => {
    const chat = await chatApp();
    try {
      const response = await chat.member.call("POST", "/api/sessions", {
        body: {
          projectId: chat.projectId,
          agentId: chat.agentId,
          message: "hello",
          capabilities: { disable: [KNOWLEDGE] },
        },
      });
      const detail = (await response.json()) as SessionDetail;
      (await waitScript(chat.scripted, 1)).reply("first");
      await settled(chat, detail.session.id);
      const regenerated = await chat.member.call(
        "POST",
        `/api/sessions/${detail.session.id}/regenerate`,
        { body: {} },
      );
      expect(regenerated.status).toBe(201);
      expect((await regenerated.json()).session.disabledCapabilities).toEqual([
        KNOWLEDGE,
      ]);
      const second = await waitScript(chat.scripted, 2);
      expect(JSON.stringify(second.body.messages)).toContain(
        KNOWLEDGE_OFF_LINE,
      );
      expect(
        chat.app.runner.registry.get(detail.session.id)!.policy.offered
          .knowledge,
      ).toBe(false);
      second.reply("again");
      await settled(chat, detail.session.id);
    } finally {
      await chat.app.shutdown();
    }
  });
});
