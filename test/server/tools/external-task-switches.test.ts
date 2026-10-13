// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The external_task tool's two switches through the composed server:
// the admin's row and the chat's key each take it off a chat and its
// subagents, a forged call writes nothing, and both on offer it.

import { describe, expect, test } from "bun:test";
import { EXTERNAL_TASKS_OFF_LINE } from "../../../src/shared/capabilities.ts";
import { type ChatApp, chatApp, type Script } from "../../helpers/chat.ts";
import { allowSubagents, system, toolNames } from "../../helpers/subagents.ts";
import { settle } from "../../helpers/tool-loop.ts";
import { briefFile } from "../external-tasks/http-fixture.ts";

async function app(): Promise<ChatApp> {
  const chat = await chatApp();
  chat.app.automationScheduler.stop();
  allowSubagents(chat, chat.agentId);
  return chat;
}

async function start(chat: ChatApp, disable: string[] = []) {
  const pending = chat.scripted.next();
  const res = await chat.member.call("POST", "/api/sessions", {
    body: {
      projectId: chat.projectId,
      agentId: chat.agentId,
      message: "hand the parser port to my agent",
      ...(disable.length === 0 ? {} : { capabilities: { disable } }),
    },
  });
  expect(res.status).toBe(201);
  const sessionId = (await res.json()).session.id as string;
  return { sessionId, script: await pending };
}

const childNames = (chat: ChatApp, sessionId: string) =>
  chat.app.runner.registry
    .get(sessionId)!
    .policy.childOffered!.tools.map((tool) => tool.name);

const switchable = async (chat: ChatApp) =>
  (
    await (
      await chat.member.call("GET", `/api/projects/${chat.projectId}/agents`)
    ).json()
  ).capabilities as string[];

// a create the model sends whether or not it was offered the tool
async function forged(chat: ChatApp, script: Script): Promise<string> {
  briefFile(chat.app, chat.projectId, chat.memberId);
  const pending = chat.scripted.next();
  script.toolRound([
    {
      id: "c1",
      name: "external_task",
      arguments: JSON.stringify({
        action: "create",
        title: "Port the parser",
        labels: ["build"],
        files: ["/knowledge/brief.md"],
      }),
    },
  ]);
  script.end();
  const next = await pending;
  const messages = next.body.messages as { role: string; content: string }[];
  next.reply("done");
  await settle(chat);
  return messages.findLast((m) => m.role === "tool")!.content;
}

const tasks = (chat: ChatApp) =>
  chat.app.externalTasks.byProject(chat.projectId).tasks;

describe("the external_task switches", () => {
  test("both on offer it to the chat and its subagents", async () => {
    const chat = await app();
    try {
      expect(await switchable(chat)).toContain("external_tasks");
      const { script, sessionId } = await start(chat);
      expect(toolNames(script)).toContain("external_task");
      expect(childNames(chat, sessionId)).toContain("external_task");
      expect(system(script)).not.toContain(EXTERNAL_TASKS_OFF_LINE);
      expect(await forged(chat, script)).toStartWith("Created external task");
      expect(tasks(chat)).toHaveLength(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the chat's key takes it off with its line and refuses a forged call", async () => {
    const chat = await app();
    try {
      const { script, sessionId } = await start(chat, ["external_tasks"]);
      expect(toolNames(script)).not.toContain("external_task");
      expect(toolNames(script)).toContain("automation");
      expect(childNames(chat, sessionId)).not.toContain("external_task");
      expect(system(script)).toContain(EXTERNAL_TASKS_OFF_LINE);
      expect(await forged(chat, script)).toBe(
        'Error: tool "external_task" not found.',
      );
      expect(tasks(chat)).toEqual([]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the admin's row takes it off every chat and the chat's switch", async () => {
    const chat = await app();
    try {
      const off = await chat.admin.call("PATCH", "/api/tools/external_task", {
        body: { enabled: false },
      });
      expect(off.status).toBe(200);
      expect((await off.json()).externalTask).toMatchObject({
        name: "external_task",
        enabled: false,
      });
      expect(await switchable(chat)).not.toContain("external_tasks");
      const { script, sessionId } = await start(chat);
      expect(toolNames(script)).not.toContain("external_task");
      expect(childNames(chat, sessionId)).not.toContain("external_task");
      expect(system(script)).not.toContain(EXTERNAL_TASKS_OFF_LINE);
      expect(await forged(chat, script)).toBe(
        'Error: tool "external_task" not found.',
      );
      expect(tasks(chat)).toEqual([]);
      const wrong = await chat.admin.call("PATCH", "/api/tools/external_task", {
        body: { hosts: [] },
      });
      expect(wrong.status).toBe(400);
      const member = await chat.member.call(
        "PATCH",
        "/api/tools/external_task",
        { body: { enabled: true } },
      );
      expect(member.status).toBe(403);
      const on = await chat.admin.call("PATCH", "/api/tools/external_task", {
        body: { enabled: true },
      });
      expect((await on.json()).externalTask.enabled).toBe(true);
      expect(await switchable(chat)).toContain("external_tasks");
    } finally {
      await chat.app.shutdown();
    }
  });
});
