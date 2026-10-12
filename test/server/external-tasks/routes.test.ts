// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, spyOn, test } from "bun:test";
import type {
  ExternalTaskResponse,
  ExternalTasksResponse,
} from "../../../src/shared/api/external-tasks.ts";
import { STALE_TASK } from "../../../src/shared/contracts/external-task.ts";
import { httpFixture } from "./http-fixture.ts";

for (const who of ["member", "admin"] as const) {
  test(`${who} edits and moves another member's task through the routes`, async () => {
    await using f = await httpFixture();
    const client = who === "admin" ? f.admin : f.member.client;
    const key = await f.key();
    const made = await f.create({ scope: "First" });
    const id = made.task.task.id;
    const base = `/api/external-tasks/${id}`;
    expect(made).toMatchObject({
      task: {
        task: {
          projectId: f.projectId,
          title: "Check the work",
          scope: "First",
          state: "open",
          revision: 0,
          editRevision: 0,
          claim: null,
          last: null,
          entries: 0,
          attentionAt: null,
        },
        text: "Read the brief.",
        files: [],
        briefAt: f.app.now.value,
        chatId: null,
      },
      entries: [],
      next: null,
      idleHours: 24,
    });
    expect(await f.show(id, client)).toEqual(made);
    for (const state of ["open", "claimed", "blocked"] as const) {
      if (state === "claimed") f.app.externalTasks.claim(key, id);
      if (state === "blocked") {
        const claimId = f.app.externalTasks.store.byId(id)!.claim!.id;
        f.app.externalTasks.report(
          key,
          id,
          claimId,
          "question",
          "Which path?",
          [],
        );
      }
      const before = await f.show(id);
      const response = await client.call("PATCH", base, {
        body: {
          editRevision: before.task.task.editRevision,
          text: `Brief while ${state}`,
          scope: null,
        },
      });
      expect(response.status).toBe(200);
      const edited: ExternalTaskResponse = await response.json();
      expect(edited.task.task.state).toBe(state);
      expect(edited.task.task.claim).toEqual(before.task.task.claim);
      expect(edited.task.task.editRevision).toBe(
        before.task.task.editRevision + 1,
      );
      expect(edited.task.task.revision).toBe(before.task.task.revision + 1);
      expect(edited.entries).toEqual(before.entries);
    }
    const blocked = await f.show(id);
    const answer = await client.call("POST", `${base}/answer`, {
      body: { state: "blocked", text: "Take the first path." },
    });
    expect(answer.status).toBe(200);
    const answered: ExternalTaskResponse = await answer.json();
    expect(answered.task.task.state).toBe("claimed");
    expect(answered.task.task.editRevision).toBe(
      blocked.task.task.editRevision,
    );
    expect(answered.entries[0]).toMatchObject({
      kind: "answer",
      text: "Take the first path.",
      keyName: null,
    });
    const late = await client.call("POST", `${base}/answer`, {
      body: { state: "claimed", text: "One more note." },
    });
    expect(late.status).toBe(200);
    expect((await late.json()).task.task.revision).toBe(
      answered.task.task.revision + 1,
    );
    // the old name has no alias
    const released = await client.call("POST", `${base}/release`, {
      body: {
        state: "claimed",
        claimId: answered.task.task.claim!.id,
        text: "Try later.",
      },
    });
    expect(released.status).toBe(404);
    const unclaimed = await client.call("POST", `${base}/unclaim`, {
      body: {
        state: "claimed",
        claimId: answered.task.task.claim!.id,
        text: "Try later.",
      },
    });
    expect(unclaimed.status).toBe(200);
    expect((await unclaimed.json()).task.task).toMatchObject({
      state: "open",
      claim: null,
    });
    expect(
      (await client.call("POST", `${base}/drop`, { body: { state: "open" } }))
        .status,
    ).toBe(200);
    expect(
      (
        await client.call("PATCH", base, {
          body: { editRevision: 3, title: "Closed" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await client.call("POST", `${base}/reopen`, {
          body: { state: "dropped", text: "Try again." },
        })
      ).status,
    ).toBe(200);
    const next = f.app.externalTasks.claim(key, id);
    f.app.externalTasks.report(
      key,
      next.task.task.id,
      next.claimId,
      "result",
      "Done.",
      [],
    );
    expect(
      (
        await client.call("PATCH", base, {
          body: { editRevision: 3, title: "Closed" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await client.call("POST", `${base}/reopen`, {
          body: { state: "done", text: "Follow up." },
        })
      ).status,
    ).toBe(200);
    f.app.externalTasks.claim(key, id);
    const deleted = await client.call("DELETE", base);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect((await client.call("GET", base)).status).toBe(404);
    expect(f.app.externalTasks.store.claimById(next.claimId)).toBeNull();
  });
}

test("stale state, claim and edit revision are conflicts that change nothing", async () => {
  await using f = await httpFixture();
  const id = (await f.create()).task.task.id;
  const key = await f.key();
  const first = f.app.externalTasks.claim(key, id);
  const base = `/api/external-tasks/${id}`;
  const client = f.member.client;
  f.app.externalTasks.report(
    key,
    first.task.task.id,
    first.claimId,
    "unclaim",
    "Restart.",
    [],
  );
  const second = f.app.externalTasks.claim(key, id);
  f.app.externalTasks.report(
    key,
    second.task.task.id,
    second.claimId,
    "question",
    "Which?",
    [],
  );
  const edit = await client.call("PATCH", base, {
    body: { editRevision: 0, title: "Edited" },
  });
  expect(edit.status).toBe(200);
  const before = await f.show(id);
  const requests = [
    ["PATCH", base, { editRevision: 0, title: "Stale" }],
    ["POST", `${base}/answer`, { state: "claimed", text: "Stale" }],
    [
      "POST",
      `${base}/unclaim`,
      { state: "blocked", claimId: first.claimId, text: "Stale" },
    ],
    ["POST", `${base}/drop`, { state: "open" }],
    ["POST", `${base}/reopen`, { state: "done", text: "Stale" }],
  ] as const;
  for (const [method, path, body] of requests) {
    const response = await client.call(method, path, { body });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: STALE_TASK });
    expect(await f.show(id)).toEqual(before);
  }
});

test("an unseen team or personal project and each of its task routes answer 404", async () => {
  await using f = await httpFixture();
  const personal = f.app.projects.personal(f.creator.user.id)!.id;
  for (const [projectId, client] of [
    [f.projectId, f.outsider.client],
    [personal, f.admin],
    [personal, f.member.client],
  ] as const) {
    const id = (await f.create({}, f.creator.client, projectId)).task.task.id;
    const base = `/api/external-tasks/${id}`;
    const project = `/api/projects/${projectId}/external-tasks`;
    for (const [method, path] of [
      ["GET", project],
      ["GET", `${project}?closed=1`],
      ["POST", project],
      ["GET", base],
      ["PATCH", base],
      ["DELETE", base],
      ...["answer", "unclaim", "drop", "reopen", "seen"].map((move) => [
        "POST",
        `${base}/${move}`,
      ]),
    ]) {
      const options = { body: method === "GET" ? undefined : {} };
      const response = await client.call(method!, path!, options);
      expect(response.status).toBe(404);
      if (path!.startsWith(base)) {
        const missing = await client.call(
          method!,
          path!.replace(id, "missing"),
          options,
        );
        expect(missing.status).toBe(404);
        expect(await response.json()).toEqual(await missing.json());
      }
    }
  }
  const own = f.app.projects.personal(f.outsider.user.id)!.id;
  const made = await f.create({}, f.outsider.client, own);
  expect(await f.show(made.task.task.id, f.outsider.client)).toEqual(made);
});

test("lists unfinished tasks by state and keeps the closed count separate", async () => {
  await using f = await httpFixture();
  const key = await f.key();
  const open = (await f.create({ title: "Open" })).task.task.id;
  const claimed = (await f.create({ title: "Claimed" })).task.task.id;
  f.app.externalTasks.claim(key, claimed);
  const blocked = (await f.create({ title: "Blocked" })).task.task.id;
  const hold = f.app.externalTasks.claim(key, blocked);
  f.app.externalTasks.report(
    key,
    hold.task.task.id,
    hold.claimId,
    "question",
    "Help?",
    [],
  );
  const closed = (await f.create({ title: "Done" })).task.task.id;
  const end = f.app.externalTasks.claim(key, closed);
  f.app.externalTasks.report(
    key,
    end.task.task.id,
    end.claimId,
    "result",
    "Done.",
    [],
  );
  const response = await f.member.client.call("GET", f.base);
  expect(response.status).toBe(200);
  const body: ExternalTasksResponse = await response.json();
  expect(body.tasks.map((row) => row.id)).toEqual([blocked, claimed, open]);
  expect(body.closed).toBe(1);
  expect(body.idleHours).toBe(24);
  expect(body.tasks[0]).toMatchObject({
    claim: { username: "creator", keyName: "terminal" },
    last: { kind: "question", text: "Help?" },
  });
});

test("linked files stay live by id and retain their deleted name without crossing projects", async () => {
  await using f = await httpFixture();
  const path = `/api/projects/${f.projectId}/knowledge`;
  const created = await f.creator.client.call("POST", path, {
    body: { name: "brief.md", text: "First." },
  });

  expect(created.status).toBe(201);
  const file = (await created.json()).file;
  const made = await f.create({ fileIds: [file.id] });
  const id = made.task.task.id;
  const held = f.app.externalTasks.claim(await f.key(), id);
  expect(held.task.files).toEqual([
    { fileId: file.id, name: "brief.md", revision: 1, deleted: false },
  ]);
  const changed = await f.creator.client.call(
    "PUT",
    `${path}/files/${file.id}`,
    { body: { revision: 1, text: "Second." } },
  );
  expect(changed.status).toBe(200);
  expect((await f.show(id)).task.files[0]?.revision).toBe(2);
  expect(
    (await f.creator.client.call("DELETE", `${path}/files/${file.id}`)).status,
  ).toBe(204);
  expect((await f.show(id)).task.files).toEqual([
    { fileId: file.id, name: "brief.md", revision: null, deleted: true },
  ]);
  expect(
    (
      await f.member.client.call("PATCH", `/api/external-tasks/${id}`, {
        body: {
          editRevision: 0,
          title: "Keep the deleted link",
          fileIds: [file.id],
        },
      })
    ).status,
  ).toBe(200);
  f.app.knowledge.emptyBin(f.projectId);
  expect((await f.show(id)).task.files[0]?.name).toBeNull();
});

test("task reads and write answers read linked file columns without their text", async () => {
  await using f = await httpFixture();
  const created = await f.creator.client.call(
    "POST",
    `/api/projects/${f.projectId}/knowledge`,
    { body: { name: "brief.md", text: "Large brief.\n".repeat(10_000) } },
  );
  expect(created.status).toBe(201);
  const file = (await created.json()).file;
  const query = spyOn(f.app.db, "query");
  try {
    const made = await f.create({ fileIds: [file.id] });
    await f.show(made.task.task.id);
    const answer = await f.member.client.call(
      "PATCH",
      `/api/external-tasks/${made.task.task.id}`,
      { body: { editRevision: 0, title: "Updated" } },
    );
    expect(answer.status).toBe(200);
    const reads = query.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => /select .* from knowledge_files/s.test(sql));
    expect(reads.length).toBeGreaterThan(0);
    for (const sql of reads)
      expect(f.app.db.query(sql).columnNames).not.toContain("text");
    expect((await answer.json()).task.files).toEqual([
      {
        fileId: file.id,
        name: file.name,
        revision: file.revision,
        deleted: false,
      },
    ]);
  } finally {
    query.mockRestore();
  }
});
