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
    const marked = await f.show(id);
    for (const conn of conns) expect(taskFrames(conn)).toHaveLength(3);
    const seen = await f.member.client.call("POST", `${base}/seen`, {
      body: { attentionAt: marked.task.task.attentionAt },
    });
    expect(seen.status).toBe(200);
    const cleared = await seen.json();
    for (const conn of conns) {
      expect(taskFrames(conn)[0]).toEqual({
        type: "externalTask",
        projectId: f.projectId,
        task: created.task.task,
      });
      expect(taskFrames(conn).at(-1)).toEqual({
        type: "externalTask",
        projectId: f.projectId,
        task: cleared.task.task,
      });
      expect(cleared.task.task.revision).toBe(marked.task.task.revision + 1);
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
      body: { state: "claimed", text: "Another note." },
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

test("the hourly sweep reads live idle limits and spares blocked and recently active claims", async () => {
  await using f = await httpFixture();
  const key = await f.key();
  const tasks = [];
  for (const title of ["idle", "blocked", "active"]) {
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
  expect((await f.show(idle!.task.task.id)).task.task.state).toBe("claimed");
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
  const released = await f.show(idle!.task.task.id);
  expect(released.task.task).toMatchObject({
    state: "open",
    claim: null,
    attentionAt: f.app.now.value,
  });
  expect(released.entries[0]).toMatchObject({
    kind: "release",
    by: null,
    claimEnd: "idle",
    text: "released after 24 hours without a report",
  });
  expect(f.app.externalTasks.store.claimById(idle!.claimId)?.end_reason).toBe(
    "idle",
  );
  expect((await f.show(blocked!.task.task.id)).task.task.state).toBe("blocked");
  expect((await f.show(active!.task.task.id)).task.task.state).toBe("claimed");
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
  expect((await f.show(idle!.task.task.id)).task.task.state).toBe("claimed");
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
      state: "open",
      claim: null,
      attentionAt: f.app.now.value,
    });
    expect(detail.entries[0]).toMatchObject({
      kind: "release",
      by: null,
      claimEnd: "access_gone",
    });
    expect(f.app.externalTasks.store.claimById(task.claimId)?.end_reason).toBe(
      "access_gone",
    );
  }
  for (const task of [older!, newer!])
    expect((await f.show(task.id)).task.task.state).toBe("blocked");
  expect(f.app.db.query("select id from access_keys").all()).toHaveLength(3);
  expect(
    f.logs.events.find((event) => event.area === "sweep")?.fields,
  ).toMatchObject({ external_access_gone: 2, external_idle: 0 });
  await f.limits({ accessKeysPerUser: 0 });
  f.app.sweep();
  for (const task of [older!, newer!]) {
    expect((await f.show(task.id)).task.task.state).toBe("open");
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
    for (const title of ["done", "dropped", "reopened"]) {
      const id = (await f.create({ title })).task.task.id;
      const claim = f.app.externalTasks.claim(key, id);
      if (title === "dropped") {
        expect(
          (
            await f.member.client.call(
              "POST",
              `/api/external-tasks/${id}/drop`,
              { body: { state: "claimed" } },
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
        `insert into ${table} (task_id, file_id, position) values (?, 'deleted-file', 0)`,
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
    expect((await f.show(reopened)).task.task.state).toBe("open");
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
        "insert into external_task_files (task_id, file_id, position) values (?, 'gone', 0)",
      )
      .run(id);
    const conn = await f.connect(f.member.client);
    expect(
      (await f.admin.call("DELETE", `/api/projects/${f.projectId}`)).status,
    ).toBe(200);
    for (const table of [
      "external_tasks",
      "external_task_files",
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
  const open = (await f.create({ title: "Open", text: "Still working." })).task
    .task.id;
  const closed = (await f.create({ title: "Closed", text: "Finished." })).task
    .task.id;
  expect(
    (
      await f.member.client.call("POST", `/api/external-tasks/${closed}/drop`, {
        body: { state: "open", text: "No longer needed." },
      })
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
    "external_tasks",
  ]);
  expect(area.rows).toBe(3);
  expect(area.bytes).toBeGreaterThan(0);
  expect(area.indexes.count).toBeGreaterThan(0);
  expect(
    storage.retention.cleaned.find((row) => row.key === "externalTasks"),
  ).toEqual({
    key: "externalTasks",
    bytes: Buffer.byteLength("ClosedFinished.No longer needed.[]"),
    days: 90,
  });
  expect(f.app.externalTasks.store.byId(open)?.state).toBe("open");
});
