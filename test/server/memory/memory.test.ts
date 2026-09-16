// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  type MemoryOperation,
  memoryWork,
  replay,
} from "../../../src/server/memory/index.ts";
import { hashPassword } from "../../../src/server/users/index.ts";
import { createAutomation } from "../../helpers/automations.ts";
import { chatApp } from "../../helpers/chat.ts";

describe("memory store", () => {
  test("enforces one project note and the automation's project", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat);
    chat.app.memory.save(
      { projectId: chat.projectId, automationId: null },
      [{ topic: "One", text: "one" }],
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
        [{ topic: "Wrong", text: "wrong" }],
        0,
        chat.adminId,
        chat.app.now.value,
      ),
    ).toThrow("automation is not in project");
    await chat.app.shutdown();
  });

  test("replays operations without changing the held working copy", () => {
    const operations: MemoryOperation[] = [
      { action: "set", topic: "a", expected: "old", text: "new" },
      { action: "remove", topic: "missing", expected: "removed" },
      { action: "set", topic: "last", expected: null, text: "last" },
    ];
    const current = [
      { topic: "a", text: "hand edit" },
      { topic: "other", text: "other" },
    ];
    const before = JSON.stringify({ current, operations });
    expect(replay(current, operations)).toEqual({
      entries: [...current, { topic: "last", text: "last" }],
      skipped: 1,
      skippedOperations: [0],
    });
    expect(JSON.stringify({ current, operations })).toBe(before);
  });

  test.each(["Undo", "hand removal", "hand rename"])(
    "remove then set never resurrects a topic after %s",
    async (change) => {
      const chat = await chatApp();
      try {
        const target = { projectId: chat.projectId, automationId: null };
        const store = chat.app.memory;
        store.save(
          target,
          [{ topic: "Note", text: "old" }],
          0,
          chat.memberId,
          chat.app.now.value,
        );
        const work = memoryWork(store.read(target));
        work.entries = [{ topic: "NOTE", text: "run" }];
        work.operations = [
          { action: "remove", topic: "Note", expected: "old" },
          { action: "set", topic: "NOTE", text: "run", expected: null },
        ];
        if (change === "Undo") {
          store.undo(target, 1, chat.memberId, chat.app.now.value);
        } else {
          store.save(
            target,
            change === "hand rename" ? [{ topic: "Renamed", text: "old" }] : [],
            1,
            chat.memberId,
            chat.app.now.value,
          );
        }
        const current = store.read(target);
        const before = structuredClone(work);
        expect(store.commit(work, "unused", chat.app.now.value)).toEqual({
          row: current,
          skipped: 1,
          skippedOperations: [1],
          changed: false,
        });
        expect(store.read(target)).toEqual(current);
        expect(work).toEqual(before);
      } finally {
        await chat.app.shutdown();
      }
    },
  );
});

describe("memory routes", () => {
  test("names invalid topics, texts and the cuts that meet the budget", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat);
    const invalid: { entries: unknown; words: string }[] = [
      { entries: ["old string"], words: "entry 1 must have a topic and text" },
      {
        entries: [{ topic: " \n\t ", text: "text" }],
        words: "topic of entry 1 is empty",
      },
      {
        entries: [{ topic: "t".repeat(61), text: "text" }],
        words: "61 characters, the limit is 60, cut 1",
      },
      {
        entries: [
          { topic: "Note", text: "text" },
          { topic: "NOTE", text: "other" },
        ],
        words: "topic NOTE is repeated",
      },
      {
        entries: [{ topic: "Snapshot", text: "\u0000 " }],
        words: "text of Snapshot is empty",
      },
      {
        entries: [{ topic: "Snapshot", text: "x".repeat(501) }],
        words: "text of Snapshot is 501 characters, the limit is 500, cut 1",
      },
      {
        entries: [{ topic: "Snapshot", text: null }],
        words: "text of Snapshot must be text",
      },
      {
        entries: Array.from({ length: 5 }, (_, i) => ({
          topic: `Topic ${i + 1}`,
          text: "x".repeat(500),
        })),
        words: "free 363. Cut or remove Topic 5.",
      },
    ];
    for (const path of [
      `/api/projects/${chat.projectId}/memory`,
      `/api/automations/${automation.id}/memory`,
    ]) {
      for (const fixture of invalid) {
        const response = await chat.member.call("PUT", path, {
          body: { entries: fixture.entries, revision: 0 },
        });
        expect(response.status).toBe(400);
        expect(await response.text()).toContain(fixture.words);
      }
      const saved = await chat.member.call("PUT", path, {
        body: {
          entries: [
            {
              topic: "\u202e Sources\nthat\twork ",
              text: " \u0000one\n\ttwo\u0085 ",
            },
          ],
          revision: 0,
        },
      });
      expect(saved.status).toBe(200);
      const memory = (await saved.json()).memory;
      expect(memory.entries).toEqual([
        { topic: "Sources that work", text: "one\n\ttwo" },
      ]);
      const read = await chat.member.call("GET", path);
      expect((await read.json()).memory).toEqual(memory);
    }
    await chat.app.shutdown();
  });

  test("uses entry equality for no-op commits and Undo still swaps whole versions", async () => {
    const chat = await chatApp();
    const target = { projectId: chat.projectId, automationId: null };
    const first = [{ topic: "Note", text: "value" }];
    chat.app.memory.save(target, first, 0, chat.memberId, chat.app.now.value);
    const work = memoryWork(chat.app.memory.read(target));
    work.entries = [{ topic: "NOTE", text: "value" }];
    work.operations.push({
      action: "set",
      topic: "NOTE",
      text: "value",
      expected: "value",
    });
    const before = JSON.stringify(work);
    expect(
      chat.app.memory.commit(work, "unused", chat.app.now.value),
    ).toMatchObject({
      changed: false,
      skipped: 0,
      row: { entries: first, revision: 1 },
    });
    expect(JSON.stringify(work)).toBe(before);
    chat.app.memory.save(
      target,
      [{ topic: "NOTE", text: "value" }],
      1,
      chat.memberId,
      chat.app.now.value,
    );
    expect(
      chat.app.memory.undo(target, 2, chat.memberId, chat.app.now.value),
    ).toMatchObject({
      entries: first,
      previous: [{ topic: "NOTE", text: "value" }],
      revision: 3,
    });
    await chat.app.shutdown();
  });

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
          projectMemory: false,
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
        body: {
          entries: [
            { topic: " One\nthing ", text: " one " },
            { topic: "Two", text: "two" },
          ],
          revision: 0,
        },
      });
      expect(first.status).toBe(200);
      expect((await first.json()).memory).toMatchObject({
        entries: [
          { topic: "One thing", text: "one" },
          { topic: "Two", text: "two" },
        ],
        previous: [],
        revision: 1,
        updatedBy: { id: chat.memberId },
        run: null,
      });
      expect(
        (
          await chat.member.call("PUT", path, {
            body: { entries: [{ topic: "Stale", text: "stale" }], revision: 0 },
          })
        ).status,
      ).toBe(409);
      const undone = await chat.member.call("POST", `${path}/undo`, {
        body: { revision: 1 },
      });
      expect((await undone.json()).memory).toMatchObject({
        entries: [],
        previous: [
          { topic: "One thing", text: "one" },
          { topic: "Two", text: "two" },
        ],
        revision: 2,
      });
      const redone = await chat.member.call("POST", `${path}/undo`, {
        body: { revision: 2 },
      });
      expect((await redone.json()).memory).toMatchObject({
        entries: [
          { topic: "One thing", text: "one" },
          { topic: "Two", text: "two" },
        ],
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
    work.entries = [{ topic: "Run", text: "from a run" }];
    work.operations.push({
      action: "set",
      topic: "Run",
      text: "from a run",
      expected: null,
    });
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
