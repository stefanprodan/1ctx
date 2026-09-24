// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { parseSaveAutomation } from "../../../src/server/automations/parse.ts";
import { automationBody, createAutomation } from "../../helpers/automations.ts";
import { chatApp } from "../../helpers/chat.ts";

describe("automation memory flag", () => {
  test("requires the flag on create", () => {
    expect(() =>
      parseSaveAutomation({
        name: "memory-task",
        agentId: "a",
        instructions: "remember",
        schedule: "0 * * * *",
        tz: "UTC",
        deadlineMs: null,
        retentionDays: 30,
      }),
    ).toThrow("missing field ownMemory");
  });

  test("refuses the removed project memory flag", async () => {
    const chat = await chatApp();
    const response = await chat.member.call(
      "POST",
      `/api/projects/${chat.projectId}/automations`,
      { body: { ...automationBody(chat), projectMemory: true } },
    );
    expect(response.status).toBe(400);
    expect(chat.app.automations.byProject(chat.projectId)).toEqual([]);
    const automation = await createAutomation(chat);
    const patched = await chat.member.call(
      "PATCH",
      `/api/automations/${automation.id}`,
      { body: { projectMemory: true } },
    );
    expect(patched.status).toBe(400);
    expect(chat.app.automations.byId(automation.id)).toEqual(automation);
    await chat.app.shutdown();
  });

  test("switches own memory on and off in a patch", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat);
    expect(automation).not.toHaveProperty("projectMemory");
    for (const ownMemory of [true, false]) {
      const changed = await chat.member.call(
        "PATCH",
        `/api/automations/${automation.id}`,
        { body: { ownMemory } },
      );
      expect(changed.status).toBe(200);
      expect((await changed.json()).automation).toMatchObject({ ownMemory });
    }
    await chat.app.shutdown();
  });

  test("keeps pre-memory rows switched off", async () => {
    const chat = await chatApp();
    chat.app.db
      .query(
        `insert into automations
          (id, project_id, owner_id, agent_id, name, instructions, schedule,
           tz, retention_days, next_at, created_at, updated_at)
         values ('old-auto', ?, ?, ?, 'old-auto', 'check', '0 * * * *',
           'UTC', 30, ?, ?, ?)`,
      )
      .run(
        chat.projectId,
        chat.memberId,
        chat.agentId,
        chat.app.now.value + 60_000,
        chat.app.now.value,
        chat.app.now.value,
      );
    expect(chat.app.automations.byId("old-auto")).toMatchObject({
      ownMemory: false,
      memoryGuidance: "",
    });
    await chat.app.shutdown();
  });
});
