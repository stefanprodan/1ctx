// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { MemoryMarkerStore } from "../../../src/server/automations/memory.ts";
import { parseSaveAutomation } from "../../../src/server/automations/parse.ts";
import { automationBody, createAutomation } from "../../helpers/automations.ts";
import { chatApp } from "../../helpers/chat.ts";

describe("automation memory flags", () => {
  test("requires both flags on create", () => {
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
    ).toThrow("missing field projectMemory");
  });

  test("refuses both memory flags on create without storing a row", async () => {
    const chat = await chatApp();
    const response = await chat.member.call(
      "POST",
      `/api/projects/${chat.projectId}/automations`,
      {
        body: automationBody(chat, {
          projectMemory: true,
          ownMemory: true,
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "ownMemory and projectMemory cannot both be on",
    });
    expect(chat.app.automations.byProject(chat.projectId)).toEqual([]);
    await chat.app.shutdown();
  });

  test.each([
    { projectMemory: true, ownMemory: false },
    { projectMemory: false, ownMemory: true },
  ])(
    "refuses a patch that enables the other memory flag: %j",
    async (flags) => {
      const chat = await chatApp();
      const automation = await createAutomation(chat, flags);
      const response = await chat.member.call(
        "PATCH",
        `/api/automations/${automation.id}`,
        {
          body: flags.projectMemory
            ? { ownMemory: true }
            : { projectMemory: true },
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "ownMemory and projectMemory cannot both be on",
      });
      expect(chat.app.automations.byId(automation.id)).toEqual(automation);
      await chat.app.shutdown();
    },
  );

  test("switches from project memory to own memory in one patch", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, {
      projectMemory: true,
      ownMemory: false,
    });
    expect(automation).toMatchObject({ projectMemory: true, ownMemory: false });
    const changed = await chat.member.call(
      "PATCH",
      `/api/automations/${automation.id}`,
      { body: { projectMemory: false, ownMemory: true } },
    );
    expect(changed.status).toBe(200);
    expect((await changed.json()).automation).toMatchObject({
      projectMemory: false,
      ownMemory: true,
    });
    expect(chat.app.automations.byId(automation.id)).toMatchObject({
      projectMemory: false,
      ownMemory: true,
    });
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
      projectMemory: false,
      ownMemory: false,
      memoryGuidance: "",
    });
    await chat.app.shutdown();
  });
});

describe("automation memory markers", () => {
  test("lists old chats first and keeps each automation's cursor apart", async () => {
    const chat = await chatApp();
    const firstAutomation = await createAutomation(chat, {
      name: "memory-one",
      projectMemory: true,
    });
    const secondAutomation = await createAutomation(chat, {
      name: "memory-two",
      projectMemory: true,
    });
    const makeSession = (
      id: string,
      at: number,
      origin: "chat" | "automation" = "chat",
    ) => {
      const row = chat.app.sessions.create({
        id,
        projectId: chat.projectId,
        ownerId: chat.memberId,
        agentId: chat.agentId,
        origin,
        automationId: origin === "automation" ? firstAutomation.id : null,
        title: id,
        now: at,
      });
      return row;
    };
    const oldest = makeSession("oldest-chat", 10);
    chat.app.sessions.touch(oldest.id, { status: "done", now: 20 });
    const newer = makeSession("newer-chat", 30);
    chat.app.sessions.touch(newer.id, { status: "done", now: 40 });
    makeSession("running-chat", 5);
    const run = makeSession("automation-run", 1, "automation");
    chat.app.sessions.touch(run.id, { status: "done", now: 2 });

    const first = chat.app.automations;
    const markers = new MemoryMarkerStore(chat.app.db);
    expect(markers.unread(firstAutomation.id, chat.projectId, 1)).toEqual({
      chats: [
        expect.objectContaining({
          id: oldest.id,
          readBefore: false,
          changedSince: false,
        }),
      ],
      remaining: 1,
    });
    expect(
      markers.mark(firstAutomation.id, [
        { sessionId: oldest.id, readActivityAt: 20 },
      ]),
    ).toBe(1);
    expect(
      markers
        .unread(firstAutomation.id, chat.projectId, 20)
        .chats.map((row) => row.id),
    ).toEqual([newer.id]);
    expect(
      markers
        .unread(secondAutomation.id, chat.projectId, 20)
        .chats.map((row) => row.id),
    ).toEqual([oldest.id, newer.id]);

    chat.app.sessions.touch(oldest.id, { status: "done", now: 50 });
    expect(
      markers.unread(firstAutomation.id, chat.projectId, 20).chats,
    ).toEqual([
      expect.objectContaining({
        id: newer.id,
        readBefore: false,
        changedSince: false,
      }),
      expect.objectContaining({
        id: oldest.id,
        readBefore: true,
        changedSince: true,
      }),
    ]);
    expect(
      markers
        .unread(firstAutomation.id, chat.projectId, 20, [newer.id])
        .chats.map((row) => row.id),
    ).toEqual([oldest.id]);

    chat.app.sessions.delete(newer.id);
    expect(
      markers.mark(firstAutomation.id, [
        { sessionId: newer.id, readActivityAt: 40 },
      ]),
    ).toBe(0);
    expect(first.byId(firstAutomation.id)).not.toBeNull();
    await chat.app.shutdown();
  });
});
