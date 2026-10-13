// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { DAY_MS, HOUR_MS } from "../../../src/server/lib/clock.ts";
import type { StorageResponse } from "../../../src/shared/api/admin.ts";
import { httpFixture } from "./http-fixture.ts";

test.serial(
  "task frames reach every visible connection without a watch and skip outsiders",
  async () => {
    await using f = await httpFixture();
    const conns = [
      await f.connect(f.creator.client),
      await f.connect(f.member.client),
      await f.connect(f.member.client),
      await f.connect(f.admin),
    ];
    const outsider = await f.connect(f.outsider.client);
    const taskFrames = (conn: typeof outsider) =>
      conn.frames.filter(
        (frame) =>
          frame.type === "externalTask" || frame.type === "externalTaskDeleted",
      );
    const created = await f.create();
    const id = created.task.task.id;
    const base = `/api/external-tasks/${id}`;
    const key = await f.key();
    const claim = f.app.externalTasks.claim(key, id);
    f.app.externalTasks.report(
      key,
      claim.task.task.id,
      claim.claimId,
      "question",
      "A question",
      [],
    );
    const asked = await f.show(id);
    for (const conn of conns) expect(taskFrames(conn)).toHaveLength(3);
    const reply = await f.member.client.call("POST", `${base}/answer`, {
      body: { state: "awaiting_input", text: "Take the first." },
    });
    expect(reply.status).toBe(200);
    const replied = await reply.json();
    for (const conn of conns) {
      expect(taskFrames(conn)[0]).toEqual({
        type: "externalTask",
        projectId: f.projectId,
        task: created.task.task,
      });
      expect(taskFrames(conn).at(-1)).toEqual({
        type: "externalTask",
        projectId: f.projectId,
        task: replied.task.task,
      });
      expect(replied.task.task.revision).toBe(asked.task.task.revision + 1);
    }
    f.app.externalTasks.report(
      key,
      claim.task.task.id,
      claim.claimId,
      "progress",
      "Found the answer.",
      [],
    );
    const answered = await f.member.client.call("POST", `${base}/answer`, {
      body: { state: "in_progress", text: "Another note." },
    });
    expect(answered.status).toBe(200);
    const row = (await answered.json()).task.task;
    expect(row.editRevision).toBe(0);
    for (const conn of conns)
      expect(taskFrames(conn).at(-1)).toEqual({
        type: "externalTask",
        projectId: f.projectId,
        task: row,
      });
    expect((await f.member.client.call("DELETE", base)).status).toBe(204);
    for (const conn of conns) {
      expect(taskFrames(conn)).toHaveLength(7);
      expect(taskFrames(conn).at(-1)).toEqual({
        type: "externalTaskDeleted",
        projectId: f.projectId,
        taskId: id,
      });
    }
    expect(taskFrames(outsider)).toEqual([]);
  },
);

test("the hourly sweep reads live idle limits and spares claims awaiting input and recently active ones", async () => {
  await using f = await httpFixture();
  const key = await f.key();
  const tasks = [];
  for (const title of ["idle", "awaiting_input", "active"]) {
    const id = (await f.create({ title })).task.task.id;
    tasks.push(f.app.externalTasks.claim(key, id));
  }
  const [idle, blocked, active] = tasks;
  f.app.externalTasks.report(
    key,
    blocked!.task.task.id,
    blocked!.claimId,
    "question",
    "Waiting.",
    [],
  );
  f.app.now.value += 25 * HOUR_MS;
  await f.limits({ externalTaskIdleHours: 30 });
  f.app.sweep();
  expect((await f.show(idle!.task.task.id)).task.task.state).toBe(
    "in_progress",
  );
  f.app.externalTasks.report(
    key,
    active!.task.task.id,
    active!.claimId,
    "progress",
    "Still working.",
    [],
  );
  await f.limits({ externalTaskIdleHours: 24 });
  f.app.sweep();
  const unclaimed = await f.show(idle!.task.task.id);
  expect(unclaimed.task.task).toMatchObject({
    state: "todo",
    claim: null,
    movedAt: f.app.now.value,
    last: { kind: "unclaim", by: null, keyName: null, claimEnd: "idle" },
  });
  expect(unclaimed.entries[0]).toMatchObject({
    kind: "unclaim",
    by: null,
    claimEnd: "idle",
    text: "after 24 hours without a report",
  });
  expect(f.app.externalTasks.store.claimById(idle!.claimId)?.end_reason).toBe(
    "idle",
  );
  expect((await f.show(blocked!.task.task.id)).task.task.state).toBe(
    "awaiting_input",
  );
  expect((await f.show(active!.task.task.id)).task.task.state).toBe(
    "in_progress",
  );
  expect(() =>
    f.app.externalTasks.report(
      key,
      idle!.task.task.id,
      idle!.claimId,
      "progress",
      "Late",
      [],
    ),
  ).toThrow("changed since you opened it");
  const reclaimed = f.app.externalTasks.claim(key, idle!.task.task.id);
  expect(reclaimed.claimId).not.toBe(idle!.claimId);
  f.app.sweep();
  expect((await f.show(idle!.task.task.id)).task.task.state).toBe(
    "in_progress",
  );
  const logged = f.logs.events.filter((event) => event.area === "sweep");
  expect(logged.some((event) => event.fields.external_idle === 1)).toBe(true);
  for (const event of logged) {
    expect(event.msg).toBe("sweep");
    expect(
      Object.values(event.fields).every((value) => typeof value === "number"),
    ).toBe(true);
  }
});

test("the sweep ends expired and missing keys but keeps every key under a positive cap", async () => {
  await using f = await httpFixture();
  const tasks = [];
  for (const name of ["expired", "missing", "older", "newer"]) {
    const key = await f.key(name);
    const id = (await f.create({ title: name })).task.task.id;
    const claim = f.app.externalTasks.claim(key, id);
    f.app.externalTasks.report(
      key,
      claim.task.task.id,
      claim.claimId,
      "question",
      "Waiting.",
      [],
    );
    tasks.push({ key, id, claimId: claim.claimId });
  }
  const [expired, missing, older, newer] = tasks;
  f.app.db
    .query("update access_keys set expires_at = ? where id = ?")
    .run(f.app.now.value, expired!.key.keyId);
  f.app.db
    .query("delete from access_keys where id = ?")
    .run(missing!.key.keyId);
  await f.limits({ accessKeysPerUser: 1 });
  f.app.sweep();
  for (const task of [expired!, missing!]) {
    const detail = await f.show(task.id);
    expect(detail.task.task).toMatchObject({
      state: "todo",
      claim: null,
      movedAt: f.app.now.value,
    });
    expect(detail.entries[0]).toMatchObject({
      kind: "unclaim",
      by: null,
      claimEnd: "access_gone",
    });
    expect(f.app.externalTasks.store.claimById(task.claimId)?.end_reason).toBe(
      "access_gone",
    );
  }
  for (const task of [older!, newer!])
    expect((await f.show(task.id)).task.task.state).toBe("awaiting_input");
  expect(f.app.db.query("select id from access_keys").all()).toHaveLength(3);
  expect(
    f.logs.events.find((event) => event.area === "sweep")?.fields,
  ).toMatchObject({ external_access_gone: 2, external_idle: 0 });
  await f.limits({ accessKeysPerUser: 0 });
  f.app.sweep();
  for (const task of [older!, newer!]) {
    expect((await f.show(task.id)).task.task.state).toBe("todo");
    expect(f.app.externalTasks.store.claimById(task.claimId)?.end_reason).toBe(
      "access_gone",
    );
  }
  expect(f.app.db.query("select id from access_keys").all()).toHaveLength(3);
});

test.serial(
  "closed retention deletes the full task and publishes its deletion but keeps reopened work",
  async () => {
    await using f = await httpFixture();
    const key = await f.key();
    const rows = [];
    for (const title of ["done", "canceled", "reopened"]) {
      const id = (await f.create({ title })).task.task.id;
      const claim = f.app.externalTasks.claim(key, id);
      if (title === "canceled") {
        expect(
          (
            await f.member.client.call(
              "POST",
              `/api/external-tasks/${id}/cancel`,
              { body: { state: "in_progress" } },
            )
          ).status,
        ).toBe(200);
      } else
        f.app.externalTasks.report(
          key,
          claim.task.task.id,
          claim.claimId,
          "result",
          "Finished.",
          [],
        );
      rows.push({ id, claimId: claim.claimId });
    }
    const reopened = rows[2]!.id;
    expect(
      (
        await f.member.client.call(
          "POST",
          `/api/external-tasks/${reopened}/reopen`,
          { body: { state: "done", text: "More work." } },
        )
      ).status,
    ).toBe(200);
    const table = "external_task_files";
    f.app.db
      .query(
        `insert into ${table} (task_id, file_id, position) values (?, 'deleted-file', 1)`,
      )
      .run(rows[0]!.id);
    f.app.now.value += 31 * DAY_MS;
    expect((await f.admin.login("admin", "hunter2-test")).status).toBe(200);
    expect((await f.member.client.login("member", "pw")).status).toBe(200);
    await f.limits({ externalTaskDays: 30 });
    const conn = await f.connect(f.member.client);
    f.app.sweep();
    for (const row of rows.slice(0, 2)) {
      expect(f.app.externalTasks.projectOf(row.id)).toBeNull();
      expect(f.app.externalTasks.store.claimById(row.claimId)).toBeNull();
      for (const table of ["external_task_files", "external_task_entries"]) {
        expect(
          f.app.db
            .query(`select * from ${table} where task_id = ?`)
            .all(row.id),
        ).toEqual([]);
      }
    }
    expect((await f.show(reopened)).task.task.state).toBe("todo");
    expect(
      conn.frames
        .filter((frame) => frame.type === "externalTaskDeleted")
        .map((frame) => frame.taskId)
        .sort(),
    ).toEqual(
      rows
        .slice(0, 2)
        .map((row) => row.id)
        .sort(),
    );
    expect(
      f.logs.events.findLast((event) => event.area === "sweep")?.fields
        .external_deleted,
    ).toBe(2);
  },
);

test.serial(
  "deleting a project cascades its tasks and sends only access changes",
  async () => {
    await using f = await httpFixture();
    const id = (await f.create()).task.task.id;
    const key = await f.key();
    const held = f.app.externalTasks.claim(key, id);
    f.app.externalTasks.report(
      key,
      held.task.task.id,
      held.claimId,
      "progress",
      "Working.",
      [],
    );
    f.app.db
      .query(
        "insert into external_task_files (task_id, file_id, position) values (?, 'gone', 1)",
      )
      .run(id);
    const conn = await f.connect(f.member.client);
    expect(
      (await f.admin.call("DELETE", `/api/projects/${f.projectId}`)).status,
    ).toBe(200);
    for (const table of [
      "external_tasks",
      "external_task_files",
      "external_task_labels",
      "external_task_claims",
      "external_task_entries",
    ]) {
      expect(f.app.db.query(`select * from ${table}`).all()).toEqual([]);
    }
    expect(conn.frames.filter((frame) => frame.type !== "hello")).toEqual([
      { type: "revoked", projectId: f.projectId },
    ]);
  },
);

test("storage assigns every task table to external and cleans only closed task bytes at the live retention", async () => {
  await using f = await httpFixture();
  const open = (await f.create({ title: "Open" })).task.task.id;
  const closed = (await f.create({ title: "Closed" })).task.task.id;
  expect(
    (
      await f.member.client.call(
        "POST",
        `/api/external-tasks/${closed}/cancel`,
        {
          body: { state: "todo", text: "No longer needed." },
        },
      )
    ).status,
  ).toBe(200);
  await f.limits({ externalTaskDays: 90 });
  const response = await f.admin.call("GET", "/api/admin/storage?tz=UTC");
  expect(response.status).toBe(200);
  const storage: StorageResponse = await response.json();
  const area = storage.areas.find((area) => area.key === "external")!;
  expect(area.tables.map((table) => table.name).sort()).toEqual([
    "external_task_claims",
    "external_task_entries",
    "external_task_files",
    "external_task_labels",
    "external_tasks",
  ]);
  // two tasks, their file and label links, and the cancel
  expect(area.rows).toBe(7);
  expect(area.bytes).toBeGreaterThan(0);
  expect(area.indexes.count).toBeGreaterThan(0);
  expect(
    storage.retention.cleaned.find((row) => row.key === "externalTasks"),
  ).toEqual({
    key: "externalTasks",
    bytes: Buffer.byteLength("ClosedNo longer needed.[]"),
    days: 90,
  });
  expect(f.app.externalTasks.store.byId(open)?.state).toBe("todo");
});

test.serial(
  "a label rename or delete sends projectLabels to the project's users, and the detail counts each label's tasks",
  async () => {
    await using f = await httpFixture();
    const conns = [await f.connect(f.creator.client), await f.connect(f.admin)];
    const outsider = await f.connect(f.outsider.client);
    const done = (await f.create({ labels: ["build", "fix"] })).task.task.id;
    await f.create({ labels: ["fix"] });
    const key = await f.key();
    const claim = f.app.externalTasks.claim(key, done);
    f.app.externalTasks.report(key, done, claim.claimId, "result", "Done.", []);
    const detail = async () => {
      const response = await f.member.client.call(
        "GET",
        `/api/projects/${f.projectId}`,
      );
      expect(response.status).toBe(200);
      return (await response.json()).project.labels as {
        id: string;
        name: string;
        tasks: number;
      }[];
    };
    const labels = await detail();
    expect(
      Object.fromEntries(labels.map((label) => [label.name, label.tasks])),
    ).toEqual({ build: 1, fix: 2, plan: 0, research: 0 });
    const fix = labels.find((label) => label.name === "fix")!;
    const labelFrames = (conn: typeof outsider) =>
      conn.frames.filter((frame) => frame.type === "projectLabels");
    const path = `/api/projects/${f.projectId}/labels`;
    // a new label or a new description changes no task
    expect(
      (await f.member.client.call("POST", path, { body: { name: "docs" } }))
        .status,
    ).toBe(201);
    expect(
      (
        await f.member.client.call("PATCH", `${path}/${fix.id}`, {
          body: { description: "Broken things" },
        })
      ).status,
    ).toBe(200);
    for (const conn of conns) expect(labelFrames(conn)).toEqual([]);
    expect(
      (
        await f.member.client.call("PATCH", `${path}/${fix.id}`, {
          body: { name: "bug" },
        })
      ).status,
    ).toBe(200);
    for (const conn of conns) {
      expect(labelFrames(conn)).toEqual([
        { type: "projectLabels", projectId: f.projectId },
      ]);
    }
    // a rename shows on the task without moving it
    const renamed = await f.show(done);
    expect(renamed.task.task.labels).toEqual(["build", "bug"]);
    expect(renamed.task.task.revision).toBe(claim.task.task.revision + 1);
    expect(
      (await f.member.client.call("DELETE", `${path}/${fix.id}`)).status,
    ).toBe(200);
    for (const conn of conns) expect(labelFrames(conn)).toHaveLength(2);
    expect(labelFrames(outsider)).toEqual([]);
    expect((await f.show(done)).task.task.labels).toEqual(["build"]);
    expect((await detail()).map((label) => label.name)).not.toContain("bug");
  },
);
