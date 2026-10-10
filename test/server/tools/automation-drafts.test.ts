// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { cutKind } from "../../../src/server/sessions/cut.ts";
import { AUTOMATION_DEFAULTS } from "../../../src/shared/automation-defaults.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  FLASH,
  type Script,
  startChat,
  waitScript,
} from "../../helpers/chat.ts";
import {
  allowSubagents,
  delegateCall,
  settled,
} from "../../helpers/subagents.ts";
import { settle } from "../../helpers/tool-loop.ts";

const create = (name = "proposed") => ({
  action: "create",
  name,
  instructions: "Check the system and report failures.",
  schedule: "0 9 * * *",
});

async function app() {
  const chat = await chatApp();
  chat.app.automationScheduler.stop();
  return chat;
}

async function round(
  chat: ChatApp,
  script: Script,
  args: Record<string, unknown>[],
) {
  const next = chat.scripted.next();
  script.toolRound(
    args.map((fields, i) => ({
      id: `c${i}`,
      name: "automation",
      arguments: JSON.stringify(fields),
    })),
  );
  script.end();
  const reply = await next;
  const messages = reply.body.messages as { role: string; content: string }[];
  return {
    script: reply,
    answers: messages
      .filter((m) => m.role === "tool")
      .slice(-args.length)
      .map((m) => m.content),
  };
}

async function finish(chat: ChatApp, script: Script, id: string) {
  script.reply("It waits for confirmation.");
  await settled(chat, id);
}

const drafts = (chat: ChatApp, id: string) =>
  chat.app.automationDrafts.bySession(id);

describe("task proposals", () => {
  test("each action writes one pending draft and no task or run", async () => {
    const chat = await app();
    try {
      const task = await createAutomation(chat, { tz: "Europe/Bucharest" });
      const { script, sessionId } = await startChat(chat);
      const result = await round(chat, script, [
        create(),
        { action: "update", id: task.id, name: "changed", once: true },
        { action: "suspend", id: task.id },
        { action: "resume", id: task.id },
        { action: "run", id: task.id },
      ]);
      expect(
        result.answers.every((text) => text.includes("waits for a person")),
      ).toBe(true);
      expect(result.answers[2]).toContain("A run already going keeps going.");
      const rows = drafts(chat, sessionId);
      expect(rows).toHaveLength(5);
      for (const action of ["create", "update", "suspend", "resume", "run"]) {
        const row = rows.find((d) => d.action === action)!;
        const stored = chat.app.automationDrafts.byId(row.id)!;
        expect(stored).toMatchObject({
          sessionId,
          userId: chat.memberId,
          agentId: chat.agentId,
          automationId: action === "create" ? null : task.id,
          editRevision: action === "create" ? null : task.editRevision,
          state: "pending",
          decidedBy: null,
          decidedAt: null,
          createdAutomationId: null,
          runSessionId: null,
        });
        const tool = chat.app.sessions.message(row.messageId)!;
        expect(tool.sessionId).toBe(sessionId);
        expect(tool.sendId).toBe(row.sendId);
        expect(tool.toolName).toBe("automation");
        expect(row.expiresAt - row.createdAt).toBe(24 * 60 * 60 * 1000);
      }
      expect(rows.find((d) => d.action === "update")!.fields).toEqual({
        name: "changed",
        once: true,
      });
      expect(chat.app.automations.byId(task.id)).toEqual(task);
      expect(chat.app.automations.count(chat.projectId)).toBe(1);
      expect(chat.app.sessions.runningAutomation(task.id)).toBe(false);
      const response = await chat.member.call(
        "GET",
        `/api/sessions/${sessionId}`,
      );
      expect((await response.json()).automationDrafts).toEqual(rows);
      await finish(chat, result.script, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("create defaults and switches come from the turn's snapshot", async () => {
    const chat = await app();
    try {
      chat.app.db
        .query("update users set tz = 'Europe/Bucharest' where id = ?")
        .run(chat.memberId);
      const { script, sessionId } = await startChat(chat);
      const send = chat.app.runner.registry.get(sessionId)!;
      // A page edit after admission must not replace the send's snapshot.
      send.policy.disabledCapabilities = [
        "automations",
        "memory",
        "web",
        "skill:gone00000000",
      ];
      chat.app.sessions.setDisabledCapabilities(sessionId, ["email"]);
      const result = await round(chat, script, [
        create(),
        { ...create("once"), once: true, tz: "UTC" },
      ]);
      const fields = drafts(chat, sessionId).find(
        (d) => d.action === "create" && d.fields.name === "proposed",
      )!.fields;
      expect(fields).toEqual({
        ...AUTOMATION_DEFAULTS,
        name: "proposed",
        instructions: create().instructions,
        schedule: create().schedule,
        agentId: chat.agentId,
        tz: "Europe/Bucharest",
        disabledCapabilities: ["skill:gone00000000", "web"],
      });
      expect(
        drafts(chat, sessionId).find(
          (d) => d.action === "create" && d.fields.name === "once",
        )!.fields,
      ).toMatchObject({ once: true, tz: "UTC" });
      await finish(chat, result.script, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a summoned agent proposes as itself", async () => {
    const chat = await app();
    try {
      const checker = await chat.makeAgent({ name: "checker", model: FLASH });
      const { script, sessionId } = await startChat(chat);
      await finish(chat, script, sessionId);
      const next = chat.scripted.next();
      const response = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/messages`,
        { body: { message: "@checker propose a task" } },
      );
      expect(response.status).toBe(201);
      const result = await round(chat, await next, [create()]);
      expect(drafts(chat, sessionId)[0]!.agentId).toBe(checker);
      expect(drafts(chat, sessionId)[0]!.fields).toMatchObject({
        agentId: checker,
      });
      await finish(chat, result.script, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("refused fields, parser bounds and schedules write no draft and return their places", async () => {
    const chat = await app();
    try {
      const task = await createAutomation(chat);
      const { script, sessionId } = await startChat(chat);
      let current = script;
      const refused = [
        { ...create(), id: task.id },
        { ...create(), agentId: chat.agentId },
        { action: "update", id: task.id },
        { action: "suspend", id: task.id, once: true },
        { action: "resume", id: task.id, tz: "UTC" },
        { action: "run", id: task.id, schedule: "0 9 * * *" },
        { ...create(), name: "" },
        { ...create(), instructions: " " },
        { ...create(), instructions: "x".repeat(256 * 1024 + 1) },
        { ...create(), schedule: "* * * * *" },
        { ...create(), schedule: "0 9 31 2 *" },
        { ...create(), schedule: "not cron" },
        { ...create(), tz: "no-zone" },
        { ...create(), once: "yes" },
        { action: "update", id: task.id, schedule: "* * * * *" },
      ];
      for (let i = 0; i < refused.length; i += 4) {
        const result = await round(chat, current, refused.slice(i, i + 4));
        expect(result.answers.every((text) => text.startsWith("Error:"))).toBe(
          true,
        );
        expect(drafts(chat, sessionId)).toHaveLength(0);
        current = result.script;
      }
      const result = await round(
        chat,
        current,
        Array.from({ length: 5 }, (_, i) => create(`valid-${i}`)),
      );
      expect(drafts(chat, sessionId)).toHaveLength(5);
      await finish(chat, result.script, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("missing and other-project tasks, a taken name, retired agent and lowered deadline are refused", async () => {
    const chat = await app();
    try {
      const task = await createAutomation(chat, {
        name: "taken",
        deadlineMs: DEFAULT_LIMITS.runDeadlineMs,
      });
      const otherProject = chat.app.projects.personal(chat.adminId)!.id;
      const hidden = chat.app.automations.create({
        ...task,
        name: "hidden",
        projectId: otherProject,
        nextAt: task.nextAt!,
        now: chat.app.now.value,
      });
      const { script, sessionId } = await startChat(chat);
      const first = await round(chat, script, [
        create("taken"),
        { action: "run", id: "gone00000000" },
        { action: "update", id: hidden.id, name: "new-name" },
        { action: "update", id: task.id, name: "hidden" },
      ]);
      expect(first.answers[0]).toContain(`/automations/${task.id}`);
      expect(first.answers[1]).toContain("no scheduled task");
      expect(first.answers[2]).toContain("no scheduled task");
      expect(drafts(chat, sessionId)).toHaveLength(1);
      chat.app.db
        .query(
          "update agents set deleted_at = ?, provider_id = null where id = ?",
        )
        .run(chat.app.now.value, chat.agentId);
      const retired = await round(chat, first.script, [
        { action: "update", id: task.id, instructions: "new" },
      ]);
      expect(retired.answers[0]).toContain(`/automations/${task.id}`);
      expect(retired.answers[0]).toContain("agent or deadline first");
      chat.app.db
        .query(
          "update agents set deleted_at = null, provider_id = ? where id = ?",
        )
        .run(chat.providerId, chat.agentId);
      chat.app.db
        .query(
          "insert into limits (name, value, updated_at) values ('runDeadlineMs', 60000, 0)",
        )
        .run();
      const deadline = await round(chat, retired.script, [
        { action: "update", id: task.id, once: true },
      ]);
      expect(deadline.answers[0]).toContain(`/automations/${task.id}`);
      expect(drafts(chat, sessionId)).toHaveLength(1);
      await finish(chat, deadline.script, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("parallel calls cannot exceed five drafts in a send, across rounds", async () => {
    const chat = await app();
    try {
      const { script, sessionId } = await startChat(chat);
      const first = await round(
        chat,
        script,
        Array.from({ length: 8 }, (_, i) => create(`cap-${i}`)),
      );
      expect(
        first.answers.filter((s) => s.includes("waits for a person")),
      ).toHaveLength(5);
      expect(
        first.answers.filter((s) => s.includes("5 task proposals")),
      ).toHaveLength(3);
      const again = await round(chat, first.script, [create("later")]);
      expect(again.answers[0]).toContain("5 task proposals");
      expect(drafts(chat, sessionId)).toHaveLength(5);
      await finish(chat, again.script, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("draft lifecycle", () => {
  test("regenerate removes pending drafts, keeps decided ones and forks copy none", async () => {
    const chat = await app();
    try {
      const { script, sessionId } = await startChat(chat);
      const result = await round(chat, script, [
        create("pending"),
        create("confirmed"),
        create("dismissed"),
      ]);
      const rows = drafts(chat, sessionId);
      for (const state of ["confirmed", "dismissed"] as const) {
        const row = rows.find(
          (d) => d.action === "create" && d.fields.name === state,
        )!;
        transact(chat.app.db, () => ({
          result: chat.app.automationDrafts.decide(
            row.id,
            state,
            chat.memberId,
            chat.app.now.value,
          ),
        }));
      }
      await finish(chat, result.script, sessionId);
      const answer = chat.app.sessions
        .messages(sessionId)
        .findLast((m) => m.slot === "answer")!;
      const fork = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/fork`,
        { body: { messageId: answer.id, agentId: chat.agentId } },
      );
      expect(fork.status).toBe(201);
      const copied = await fork.json();
      expect(copied.automationDrafts).toEqual([]);
      expect(
        copied.messages.filter(
          (m: { toolName: string }) => m.toolName === "automation",
        ),
      ).toHaveLength(3);
      const next = chat.scripted.next();
      expect(
        (
          await chat.member.call(
            "POST",
            `/api/sessions/${sessionId}/regenerate`,
            { body: {} },
          )
        ).status,
      ).toBe(201);
      expect(
        drafts(chat, sessionId)
          .map((d) => d.state)
          .sort(),
      ).toEqual(["confirmed", "dismissed"]);
      expect(
        drafts(chat, sessionId).every(
          (d) => d.decidedBy?.id === chat.memberId && d.decidedAt !== null,
        ),
      ).toBe(true);
      await finish(chat, await next, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a cut keeps its draft and automation remains a read", async () => {
    const chat = await app();
    try {
      const { script, sessionId } = await startChat(chat);
      const result = await round(chat, script, [create()]);
      expect(
        (await chat.member.call("POST", `/api/sessions/${sessionId}/stop`))
          .status,
      ).toBe(200);
      await settled(chat, sessionId);
      expect(drafts(chat, sessionId)).toHaveLength(1);
      expect(drafts(chat, sessionId)[0]!.state).toBe("pending");
      expect(cutKind("automation", null)).toBe("read");
      result.script.end();
    } finally {
      await chat.app.shutdown();
    }
  });

  test("archive expires pending drafts atomically; delete cascades every state", async () => {
    const chat = await app();
    try {
      const { script, sessionId } = await startChat(chat);
      const result = await round(chat, script, [
        create("pending"),
        create("decided"),
      ]);
      const decided = drafts(chat, sessionId)[1]!;
      chat.app.automationDrafts.decide(
        decided.id,
        "dismissed",
        chat.memberId,
        chat.app.now.value,
      );
      await finish(chat, result.script, sessionId);
      expect(() =>
        transact(chat.app.db, () => {
          chat.app.sessions.archive(
            sessionId,
            "manual",
            chat.memberId,
            chat.app.now.value,
          );
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(drafts(chat, sessionId).some((d) => d.state === "pending")).toBe(
        true,
      );
      const archive = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/archive`,
      );
      expect(archive.status).toBe(204);
      expect(
        drafts(chat, sessionId)
          .map((d) => d.state)
          .sort(),
      ).toEqual(["dismissed", "expired"]);
      expect(
        (await chat.member.call("DELETE", `/api/sessions/${sessionId}`)).status,
      ).toBe(200);
      expect(drafts(chat, sessionId)).toEqual([]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the session sweep expires pending drafts at twenty-four hours, never decided ones", async () => {
    const chat = await app();
    try {
      const { script, sessionId } = await startChat(chat);
      const result = await round(chat, script, [
        create("pending"),
        create("decided"),
      ]);
      const rows = drafts(chat, sessionId);
      chat.app.automationDrafts.decide(
        rows[1]!.id,
        "confirmed",
        chat.memberId,
        chat.app.now.value,
      );
      await finish(chat, result.script, sessionId);
      chat.app.now.value = rows[0]!.expiresAt - 1;
      chat.app.sweep();
      expect(drafts(chat, sessionId)[0]!.state).toBe("pending");
      chat.app.now.value++;
      chat.app.sweep();
      expect(
        drafts(chat, sessionId)
          .map((d) => d.state)
          .sort(),
      ).toEqual(["confirmed", "expired"]);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("forged proposals", () => {
  test("a chat subagent has a read-only schema and cannot propose", async () => {
    const chat = await app();
    try {
      allowSubagents(chat, chat.agentId);
      const { script, sessionId } = await startChat(chat);
      const parent = chat.app.runner.registry.get(sessionId)!;
      const schema = parent.policy.childOffered!.tools.find(
        (t) => t.name === "automation",
      )!;
      expect(schema.parameters).toMatchObject({
        properties: { action: { enum: ["list", "show"] } },
      });
      const next = chat.scripted.next();
      script.toolRound([delegateCall("child", "propose the task")]);
      script.end();
      const child = await next;
      const refused = await round(chat, child, [create()]);
      expect(refused.answers[0]).toContain("action must be list or show");
      const done = chat.scripted.next();
      refused.script.reply("Cannot propose.");
      await finish(chat, await done, sessionId);
      expect(drafts(chat, sessionId)).toEqual([]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a run, its attention step and memory phase refuse forged proposals", async () => {
    const chat = await app();
    try {
      const task = await createAutomation(chat, {
        ownMemory: true,
        attentionMode: "agent",
      });
      const run = await startRun(chat, task.id);
      const main = await round(chat, run.main, [create()]);
      expect(main.answers[0]).toContain("not found");
      const nextCount = chat.scripted.scripts.length + 1;
      main.script.reply("Done.");
      const attention = await waitScript(chat.scripted, nextCount);
      const step = await round(chat, attention, [create()]);
      expect(step.answers[0]).toContain("only needs_attention");
      const memoryCount = chat.scripted.scripts.length + 1;
      step.script.reply("ok");
      const memory = await waitScript(chat.scripted, memoryCount);
      const phase = await round(chat, memory, [create()]);
      expect(phase.answers[0]).toContain("only memory_edit");
      phase.script.reply("No changes.");
      await settleRun(chat, run.sessionId);
      await settle(chat);
      expect(
        chat.app.db.query("select count(*) as n from automation_drafts").get(),
      ).toEqual({ n: 0 });
    } finally {
      await chat.app.shutdown();
    }
  });
});
