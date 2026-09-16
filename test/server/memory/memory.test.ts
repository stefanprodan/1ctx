// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { memoryWork, replay } from "../../../src/server/memory/index.ts";
import { hashPassword } from "../../../src/server/users/index.ts";
import { createAutomation } from "../../helpers/automations.ts";
import { chatApp } from "../../helpers/chat.ts";

describe("memory store", () => {
  test("enforces one project note and the automation's project", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat);
    chat.app.memory.save(
      { projectId: chat.projectId, automationId: null },
      ["one"],
      0,
      chat.memberId,
      chat.app.now.value,
    );
    expect(() =>
      chat.app.db
        .query(
          `insert into memory_notes
            (project_id, automation_id, entries, revision, updated_at)
           values (?, null, '[]', 1, ?)`,
        )
        .run(chat.projectId, chat.app.now.value),
    ).toThrow();
    const other = chat.app.projects.personal(chat.adminId)!;
    expect(() =>
      chat.app.memory.save(
        { projectId: other.id, automationId: automation.id },
        ["wrong"],
        0,
        chat.adminId,
        chat.app.now.value,
      ),
    ).toThrow("automation is not in project");
    await chat.app.shutdown();
  });

  test("replays operations without changing the held working copy", () => {
    const operations = [
      { action: "replace" as const, oldText: "a", text: "new" },
      { action: "remove" as const, oldText: "missing" },
      { action: "add" as const, text: "last" },
    ];
    const current = ["a moved", "other"];
    expect(replay(current, operations)).toEqual({
      entries: ["new", "other", "last"],
      skipped: 1,
      skippedOperations: [1],
    });
    expect(current).toEqual(["a moved", "other"]);
  });
});

describe("memory routes", () => {
  test("a team member saves, compares and undoes both notes", async () => {
    const chat = await chatApp();
    const createdProject = await chat.admin.call("POST", "/api/projects", {
      body: { name: "memory-team", description: "" },
    });
    const project = (await createdProject.json()).project;
    await chat.admin.call("POST", `/api/projects/${project.id}/members`, {
      body: { userId: chat.memberId },
    });
    const createdAutomation = await chat.member.call(
      "POST",
      `/api/projects/${project.id}/automations`,
      {
        body: {
          name: "memory-task",
          agentId: chat.agentId,
          instructions: "remember",
          schedule: "0 * * * *",
          tz: "UTC",
          deadlineMs: null,
          retentionDays: 30,
          projectMemory: true,
          ownMemory: true,
        },
      },
    );
    expect(createdAutomation.status).toBe(201);
    const automation = (await createdAutomation.json()).automation;

    const neverWritten = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/memory/undo`,
      { body: { revision: 0 } },
    );
    expect(neverWritten.status).toBe(409);

    for (const path of [
      `/api/projects/${project.id}/memory`,
      `/api/automations/${automation.id}/memory`,
    ]) {
      const first = await chat.member.call("PUT", path, {
        body: { entries: [" one ", "one", "two"], revision: 0 },
      });
      expect(first.status).toBe(200);
      expect((await first.json()).memory).toMatchObject({
        entries: ["one", "two"],
        previous: [],
        revision: 1,
        updatedBy: { id: chat.memberId },
        run: null,
      });
      expect(
        (
          await chat.member.call("PUT", path, {
            body: { entries: ["stale"], revision: 0 },
          })
        ).status,
      ).toBe(409);
      const undone = await chat.member.call("POST", `${path}/undo`, {
        body: { revision: 1 },
      });
      expect((await undone.json()).memory).toMatchObject({
        entries: [],
        previous: ["one", "two"],
        revision: 2,
      });
      const redone = await chat.member.call("POST", `${path}/undo`, {
        body: { revision: 2 },
      });
      expect((await redone.json()).memory).toMatchObject({
        entries: ["one", "two"],
        previous: [],
        revision: 3,
      });
    }

    await chat.app.shutdown();
  });

  test("hides notes outside the project and keeps deleted-run provenance", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat);
    const run = chat.app.sessions.create({
      projectId: chat.projectId,
      ownerId: chat.memberId,
      agentId: chat.agentId,
      origin: "automation",
      automationId: automation.id,
      title: automation.name,
      now: chat.app.now.value,
    });
    chat.app.sessions.touch(run.id, {
      status: "done",
      now: chat.app.now.value + 1,
    });
    const work = memoryWork(
      chat.app.memory.read({ projectId: chat.projectId, automationId: null }),
    );
    work.entries = ["from a run"];
    work.operations.push({ action: "add", text: "from a run" });
    chat.app.memory.commit(work, run.id, chat.app.now.value + 1);
    const deleted = await chat.member.call(
      "DELETE",
      `/api/automations/${automation.id}`,
    );
    expect(deleted.status).toBe(204);
    const note = await (
      await chat.member.call("GET", `/api/projects/${chat.projectId}/memory`)
    ).json();
    expect(note.memory.run).toEqual({
      sessionId: run.id,
      automationId: null,
      automationName: null,
    });

    const outsider = chat.app.createUser({
      username: "outsider",
      fullName: "Outside User",
      email: "outside@example.com",
      role: "member",
      passwordHash: await hashPassword("pw"),
      mustChangePassword: false,
      now: chat.app.now.value,
    });
    const client = chat.app.client();
    await client.login(outsider.username, "pw");
    expect(
      (await client.call("GET", `/api/projects/${chat.projectId}/memory`))
        .status,
    ).toBe(404);
    expect(
      (await chat.admin.call("GET", `/api/projects/${chat.projectId}/memory`))
        .status,
    ).toBe(404);
    await chat.app.shutdown();
  });
});
