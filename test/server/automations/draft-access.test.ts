// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { hashPassword } from "../../helpers/app.ts";
import {
  createProposal,
  draftApp,
  press,
  proposals,
} from "../../helpers/automation-drafts.ts";
import { automationBody, settleRun } from "../../helpers/automations.ts";

test("team members and instance admins confirm as themselves; no-op edits keep the owner", async () => {
  const chat = await draftApp();
  try {
    const project = (
      await (
        await chat.admin.call("POST", "/api/projects", {
          body: { name: "team", description: "Work together." },
        })
      ).json()
    ).project;
    const drew = chat.app.createUser({
      username: "drew",
      fullName: "Drew",
      email: "drew@example.test",
      role: "member",
      passwordHash: await hashPassword("pw"),
      mustChangePassword: false,
      now: chat.app.now.value,
    });
    const member = chat.app.client();
    await member.login("drew", "pw");
    for (const userId of [chat.memberId, drew.id]) {
      expect(
        (
          await chat.admin.call("POST", `/api/projects/${project.id}/members`, {
            body: { userId },
          })
        ).status,
      ).toBe(201);
    }
    const create = await proposals(chat, [createProposal()], project.id);
    expect(
      (await press(chat, create.drafts[0]!.id, "confirm", member)).status,
    ).toBe(200);
    const draft = chat.app.automationDrafts.byId(create.drafts[0]!.id)!;
    const id = draft.createdAutomationId!;
    expect(chat.app.automations.byId(id)!.ownerId).toBe(drew.id);
    expect(draft.decidedBy).toBe(drew.id);
    const unchanged = await proposals(
      chat,
      [{ action: "update", id, instructions: createProposal().instructions }],
      project.id,
    );
    const before = chat.app.automations.byId(id)!;
    expect((await press(chat, unchanged.drafts[0]!.id)).status).toBe(200);
    expect(chat.app.automations.byId(id)).toEqual(before);
    expect(
      chat.app.automationDrafts.byId(unchanged.drafts[0]!.id)!.decidedBy,
    ).toBe(chat.memberId);
    const update = await proposals(
      chat,
      [{ action: "update", id, instructions: "Admin's words." }],
      project.id,
    );
    expect(
      (await press(chat, update.drafts[0]!.id, "confirm", chat.admin)).status,
    ).toBe(200);
    expect(chat.app.automations.byId(id)!.ownerId).toBe(chat.adminId);
    const prepared = await chat.admin.call("PATCH", `/api/automations/${id}`, {
      body: {
        ownMemory: false,
        attentionMode: "off",
        editRevision: chat.app.automations.byId(id)!.editRevision,
      },
    });
    expect(prepared.status).toBe(200);
    for (const action of ["suspend", "resume", "run"]) {
      const proposed = await proposals(chat, [{ action, id }], project.id);
      const next = action === "run" ? chat.scripted.next() : null;
      expect(
        (await press(chat, proposed.drafts[0]!.id, "confirm", member)).status,
      ).toBe(200);
      const current = chat.app.automations.byId(id)!;
      expect(current.ownerId).toBe(chat.adminId);
      if (action === "suspend") expect(current.suspendedBy?.id).toBe(drew.id);
      if (next !== null) {
        const runId = chat.app.automationDrafts.byId(proposed.drafts[0]!.id)!
          .runSessionId!;
        expect(chat.app.sessions.byId(runId)!.ownerId).toBe(drew.id);
        (await next).reply("Done.");
        await settleRun(chat, runId);
      }
    }
    const page = await chat.member.call(
      "POST",
      `/api/projects/${project.id}/automations`,
      { body: automationBody(chat, { name: "page-owned" }) },
    );
    expect(page.status).toBe(201);
    const pageId = (await page.json()).automation.id;
    const pageEdit = await member.call("PATCH", `/api/automations/${pageId}`, {
      body: { instructions: "Drew's words.", editRevision: 0 },
    });
    expect(pageEdit.status).toBe(200);
    expect((await pageEdit.json()).automation.ownerId).toBe(drew.id);
    const dismiss = await proposals(
      chat,
      [createProposal("dismiss")],
      project.id,
    );
    expect(
      (await press(chat, dismiss.drafts[0]!.id, "dismiss", member)).status,
    ).toBe(200);
    expect(
      chat.app.automationDrafts.byId(dismiss.drafts[0]!.id)!.decidedBy,
    ).toBe(drew.id);
  } finally {
    await chat.app.shutdown();
  }
});

test("a draft outside the caller's project is the same 404 as its chat", async () => {
  const chat = await draftApp();
  try {
    const hidden = await proposals(chat, [createProposal()]);
    const expected = await chat.admin.call(
      "GET",
      `/api/sessions/${hidden.sessionId}`,
    );
    expect(expected.status).toBe(404);
    const body = await expected.json();
    for (const action of ["confirm", "dismiss"]) {
      const response = await press(
        chat,
        hidden.drafts[0]!.id,
        action,
        chat.admin,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(body);
    }
    const project = (
      await (
        await chat.admin.call("POST", "/api/projects", {
          body: { name: "hidden-team", description: "Private work." },
        })
      ).json()
    ).project;
    const team = await proposals(
      chat,
      [createProposal()],
      project.id,
      chat.admin,
    );
    for (const action of ["confirm", "dismiss"]) {
      const response = await press(chat, team.drafts[0]!.id, action);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(body);
    }
    expect(chat.app.automationDrafts.byId(hidden.drafts[0]!.id)!.state).toBe(
      "pending",
    );
    expect(chat.app.automationDrafts.byId(team.drafts[0]!.id)!.state).toBe(
      "pending",
    );
    const archived = await chat.member.call(
      "POST",
      `/api/sessions/${hidden.sessionId}/archive`,
    );
    expect(archived.status).toBe(204);
    const late = await press(chat, hidden.drafts[0]!.id);
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ state: "expired" });
  } finally {
    await chat.app.shutdown();
  }
});
