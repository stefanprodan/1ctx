// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { AutomationSummary } from "../../../src/shared/contracts/automation.ts";
import { STALE_EDIT } from "../../../src/shared/contracts/automation.ts";
import {
  createProposal,
  draftApp,
  press,
  proposals,
} from "../../helpers/automation-drafts.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import { setLimits, startChat } from "../../helpers/chat.ts";
import { settled } from "../../helpers/subagents.ts";

const taskValues = ({ id: _id, name: _name, ...row }: AutomationSummary) => row;

describe("task draft decisions", () => {
  test("a proposed create is exactly the form's create", async () => {
    const chat = await draftApp();
    try {
      const { drafts } = await proposals(chat, [createProposal()]);
      const draft = drafts[0]!;
      expect((await press(chat, draft.id)).status).toBe(200);
      const decided = chat.app.automationDrafts.byId(draft.id)!;
      expect(decided).toMatchObject({
        state: "confirmed",
        decidedBy: chat.memberId,
        decidedAt: chat.app.now.value,
      });
      const task = chat.app.automations.byId(decided.createdAutomationId!)!;
      const response = await chat.member.call(
        "POST",
        `/api/projects/${chat.projectId}/automations`,
        {
          body: { ...draft.fields, name: "page-created" },
        },
      );
      expect(response.status).toBe(201);
      expect(taskValues(task)).toEqual(
        taskValues((await response.json()).automation),
      );
      expect(task.ownerId).toBe(chat.memberId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("update, suspend and resume use the form's actions, including no-ops", async () => {
    const chat = await draftApp();
    try {
      let task = await createAutomation(chat, { name: "proposed-task" });
      let page = await createAutomation(chat, { name: "page-task" });
      const patch = {
        instructions: "Check again.",
        schedule: "0 10 * * *",
        tz: "Europe/Bucharest",
        once: true,
      };
      for (const action of [
        "update",
        "suspend",
        "suspend",
        "resume",
        "resume",
      ] as const) {
        const { drafts } = await proposals(chat, [
          { action, id: task.id, ...(action === "update" ? patch : {}) },
        ]);
        const response = await press(chat, drafts[0]!.id);
        expect(response.status).toBe(200);
        const form = await chat.member.call(
          action === "update" ? "PATCH" : "POST",
          `/api/automations/${page.id}${action === "update" ? "" : `/${action}`}`,
          action === "update"
            ? { body: { ...patch, editRevision: page.editRevision } }
            : {},
        );
        expect(form.status).toBe(200);
        task = chat.app.automations.byId(task.id)!;
        page = (await form.json()).automation;
        expect(taskValues(task)).toEqual(taskValues(page));
        expect(chat.app.automationDrafts.byId(drafts[0]!.id)!.state).toBe(
          "confirmed",
        );
      }
      const before = task;
      const { drafts } = await proposals(chat, [
        { action: "update", id: task.id, instructions: task.instructions },
      ]);
      expect((await press(chat, drafts[0]!.id)).status).toBe(200);
      expect(chat.app.automations.byId(task.id)).toEqual(before);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a proposed run uses the same manual fire as the page and records its link", async () => {
    const chat = await draftApp();
    try {
      const task = await createAutomation(chat);
      const { drafts } = await proposals(chat, [
        { action: "run", id: task.id },
      ]);
      const next = chat.scripted.next();
      expect((await press(chat, drafts[0]!.id)).status).toBe(200);
      const draft = chat.app.automationDrafts.byId(drafts[0]!.id)!;
      const run = chat.app.sessions.byId(draft.runSessionId!)!;
      expect(run).toMatchObject({
        origin: "automation",
        runSource: "manual",
        ownerId: chat.memberId,
        automationId: task.id,
      });
      const script = await next;
      const body = script.body;
      script.reply("Done.");
      await settleRun(chat, run.id);
      const page = await startRun(chat, task.id);
      expect(page.main.body.messages).toEqual(body.messages);
      expect(page.main.body.tools).toEqual(body.tools);
      const pageRun = chat.app.sessions.byId(page.sessionId)!;
      expect(pageRun).toMatchObject({
        origin: run.origin,
        runSource: run.runSource,
        ownerId: run.ownerId,
        automationId: run.automationId,
      });
      page.main.reply("Done.");
      await settleRun(chat, page.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("dismiss writes no task and a later confirm answers the decided state", async () => {
    const chat = await draftApp();
    try {
      const { drafts } = await proposals(chat, [createProposal()]);
      const draft = drafts[0]!;
      expect((await press(chat, draft.id, "dismiss")).status).toBe(200);
      expect(chat.app.automationDrafts.byId(draft.id)).toMatchObject({
        state: "dismissed",
        decidedBy: chat.memberId,
        decidedAt: chat.app.now.value,
      });
      const response = await press(chat, draft.id);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ state: "dismissed" });
      expect(chat.app.automations.count(chat.projectId)).toBe(0);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("two confirms, and a confirm racing dismiss, decide and act only once", async () => {
    const chat = await draftApp();
    try {
      for (const second of ["confirm", "dismiss"]) {
        const { drafts } = await proposals(chat, [createProposal(second)]);
        const responses = await Promise.all([
          press(chat, drafts[0]!.id),
          press(chat, drafts[0]!.id, second),
        ]);
        expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
        const state = chat.app.automationDrafts.byId(drafts[0]!.id)!.state;
        expect(
          await responses.find((r) => r.status === 409)!.json(),
        ).toMatchObject({ state });
      }
      expect(chat.app.automations.count(chat.projectId)).toBe(2);
      const { drafts } = await proposals(chat, [
        createProposal("dismiss-first"),
      ]);
      const responses = await Promise.all([
        press(chat, drafts[0]!.id, "dismiss"),
        press(chat, drafts[0]!.id),
      ]);
      expect(responses.map((r) => r.status)).toEqual([200, 409]);
      expect(chat.app.automations.count(chat.projectId)).toBe(2);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an edit, a taken name, a deleted task and expiry keep their refusals", async () => {
    const chat = await draftApp();
    try {
      const task = await createAutomation(chat);
      for (const action of ["update", "suspend", "resume", "run"]) {
        const current = chat.app.automations.byId(task.id)!;
        const { drafts } = await proposals(chat, [
          {
            action,
            id: task.id,
            ...(action === "update" ? { instructions: "draft" } : {}),
          },
        ]);
        expect(
          (
            await chat.member.call("PATCH", `/api/automations/${task.id}`, {
              body: {
                instructions: `page-${action}`,
                editRevision: current.editRevision,
              },
            })
          ).status,
        ).toBe(200);
        const response = await press(chat, drafts[0]!.id);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          state: "stale",
          error: STALE_EDIT,
        });
        expect(chat.app.automationDrafts.byId(drafts[0]!.id)!.state).toBe(
          "stale",
        );
      }
      const creates = await proposals(chat, [createProposal("taken-later")]);
      const updates = await proposals(chat, [
        { action: "update", id: task.id, name: "taken-later" },
      ]);
      await createAutomation(chat, { name: "taken-later" });
      for (const draft of [creates.drafts[0]!, updates.drafts[0]!]) {
        const response = await press(chat, draft.id);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          state: "stale",
          error: "name is taken",
        });
        expect(chat.app.automationDrafts.byId(draft.id)!.state).toBe("stale");
      }
      const gone = await proposals(chat, [{ action: "run", id: task.id }]);
      expect(
        (await chat.member.call("DELETE", `/api/automations/${task.id}`))
          .status,
      ).toBe(204);
      const deleted = await press(chat, gone.drafts[0]!.id);
      expect(deleted.status).toBe(409);
      expect(await deleted.json()).toEqual({
        state: "stale",
        error: "the task is gone",
      });
      expect(chat.app.automationDrafts.byId(gone.drafts[0]!.id)!.state).toBe(
        "stale",
      );
      const expired = await proposals(chat, [createProposal("expires")]);
      chat.app.now.value = expired.drafts[0]!.expiresAt;
      const late = await press(chat, expired.drafts[0]!.id);
      expect(late.status).toBe(409);
      expect(await late.json()).toEqual({
        state: "expired",
        error: "the proposal expired",
      });
      expect(chat.app.automationDrafts.byId(expired.drafts[0]!.id)!.state).toBe(
        "expired",
      );
      expect(chat.app.automations.count(chat.projectId)).toBe(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a confirm racing the page's edit has one winner at the edit revision", async () => {
    const chat = await draftApp();
    try {
      const task = await createAutomation(chat);
      const { drafts } = await proposals(chat, [
        { action: "update", id: task.id, instructions: "draft" },
      ]);
      const responses = await Promise.all([
        chat.member.call("PATCH", `/api/automations/${task.id}`, {
          body: { instructions: "page", editRevision: task.editRevision },
        }),
        press(chat, drafts[0]!.id),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      const updated = chat.app.automations.byId(task.id)!;
      expect(updated.editRevision).toBe(task.editRevision + 1);
      expect(updated.instructions).toBe(
        responses[1]!.status === 200 ? "draft" : "page",
      );
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a scheduled fire, even a once fire, leaves the edit revision valid", async () => {
    const chat = await draftApp();
    try {
      const task = await createAutomation(chat, { once: true });
      const { drafts } = await proposals(chat, [
        { action: "update", id: task.id, instructions: "after fire" },
      ]);
      chat.app.now.value = task.nextAt!;
      const next = chat.scripted.next();
      const detail = await chat.app.automationScheduler.fire(task.id);
      expect(detail).not.toBeNull();
      const fired = chat.app.automations.byId(task.id)!;
      expect(fired.editRevision).toBe(task.editRevision);
      expect(fired.revision).toBeGreaterThan(task.revision);
      expect((await press(chat, drafts[0]!.id)).status).toBe(200);
      expect(chat.app.automations.byId(task.id)!.instructions).toBe(
        "after fire",
      );
      (await next).reply("Done.");
      await settleRun(chat, detail!.session.id);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a full manual run cap and a run still going leave the draft pending", async () => {
    const chat = await draftApp();
    try {
      const task = await createAutomation(chat);
      const { drafts } = await proposals(chat, [
        { action: "run", id: task.id },
      ]);
      await setLimits(chat, { sendsPerUser: 1 });
      const held = await startChat(chat);
      const full = await press(chat, drafts[0]!.id);
      expect(full.status).toBe(409);
      expect(await full.json()).toMatchObject({ state: "pending" });
      expect(chat.app.automationDrafts.byId(drafts[0]!.id)!.state).toBe(
        "pending",
      );
      expect(chat.app.sessions.runningAutomation(task.id)).toBe(false);
      held.script.reply("Done.");
      await settled(chat, held.sessionId);
      const run = await startRun(chat, task.id);
      const busy = await press(chat, drafts[0]!.id);
      expect(busy.status).toBe(409);
      expect(await busy.json()).toEqual({
        state: "pending",
        error: "still running",
      });
      expect(chat.app.automationDrafts.byId(drafts[0]!.id)!.state).toBe(
        "pending",
      );
      run.main.reply("Done.");
      await settleRun(chat, run.sessionId);
      const next = chat.scripted.next();
      expect((await press(chat, drafts[0]!.id)).status).toBe(200);
      (await next).reply("Done.");
      await settleRun(
        chat,
        chat.app.automationDrafts.byId(drafts[0]!.id)!.runSessionId!,
      );
    } finally {
      await chat.app.shutdown();
    }
  });

  test("stored create and patch fields still meet every form parser bound", async () => {
    const chat = await draftApp();
    try {
      const task = await createAutomation(chat);
      const { drafts } = await proposals(chat, [
        createProposal(),
        { action: "update", id: task.id, once: true },
      ]);
      for (const draft of drafts) {
        chat.app.db
          .query("update automation_drafts set fields = ? where id = ?")
          .run(
            JSON.stringify({ ...draft.fields, instructions: " " }),
            draft.id,
          );
        expect((await press(chat, draft.id)).status).toBe(400);
        expect(chat.app.automationDrafts.byId(draft.id)!.state).toBe("pending");
      }
      expect(chat.app.automations.byId(task.id)).toEqual(task);
      expect(chat.app.automations.count(chat.projectId)).toBe(1);
    } finally {
      await chat.app.shutdown();
    }
  });
});
