// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, spyOn, test } from "bun:test";
import type { TaskKey } from "../../../src/server/external-tasks/index.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { createKey } from "../../helpers/access-keys.ts";
import type { TestApp, TestClient } from "../../helpers/app.ts";
import { emailApp, MARIA_PASSWORD } from "../../helpers/links.ts";
import { createTeam } from "../../helpers/projects.ts";
import { httpFixture } from "./http-fixture.ts";

async function keyFor(client: TestClient, userId: string): Promise<TaskKey> {
  const { key } = await createKey(client);
  return { userId, keyId: key.id, keyName: key.name };
}

function hold(app: TestApp, key: TaskKey, projectId: string, blocked = false) {
  const id = app.externalTasks.create(key.userId, projectId, {
    title: "Do the work",
    text: "Read the brief.",
    fileIds: [],
  }).task.task.id;
  const { claimId } = app.externalTasks.claim(key, id);
  if (blocked) {
    const report = app.externalTasks.report(
      key,
      id,
      claimId,
      "question",
      "Which path?",
      [],
    );
    app.externalTasks.seen(id, { attentionAt: report.task.attentionAt! });
  }
  return { id, claimId };
}

type Held = ReturnType<typeof hold>;

async function atomicEnding(
  app: TestApp,
  act: () => Promise<Response>,
  status: number,
  ended: Held[],
  kept: Held[],
) {
  const { db, externalTasks: tasks } = app;
  const ids = new Set(ended.map((task) => task.id));
  const before = [...ended, ...kept].map((task) => tasks.show(task.id, null));
  const accessState = () =>
    ["users", "access_keys", "logins", "memberships", "user_links"].map(
      (table) => db.query(`select * from ${table} order by rowid`).all(),
    );
  const accessBefore = accessState();
  const events: BusEvent[] = [];
  const publishedIn: boolean[] = [];
  const writtenIn: boolean[] = [];
  const stop = subscribe((event) => {
    if (event.type !== "externalTask.changed" || !ids.has(event.data.task.id))
      return;
    events.push(event);
    publishedIn.push(db.inTransaction);
  }, silent);
  let fail = true;
  const move = tasks.store.move.bind(tasks.store);
  const write = spyOn(tasks.store, "move").mockImplementation((...args) => {
    move(...args);
    writtenIn.push(db.inTransaction);
    if (fail) throw new Error("claim ending failed");
  });
  try {
    expect((await act()).status).toBe(500);
    expect(writtenIn).toEqual([true]);
    expect(accessState()).toEqual(accessBefore);
    expect(
      [...ended, ...kept].map((task) => tasks.show(task.id, null)),
    ).toEqual(before);
    expect(events).toEqual([]);
    fail = false;
    expect((await act()).status).toBe(status);
    expect(writtenIn).toEqual(Array(ended.length + 1).fill(true));
    expect(publishedIn).toEqual(Array(ended.length).fill(false));
    for (const [i, held] of ended.entries()) {
      const current = tasks.show(held.id, null)!;
      expect(current.task.task).toMatchObject({
        state: "open",
        claim: null,
        attentionAt: app.now.value,
        revision: before[i]!.task.task.revision + 1,
        editRevision: before[i]!.task.task.editRevision,
        entries: before[i]!.task.task.entries + 1,
      });
      expect(current.entries[0]).toMatchObject({
        kind: "unclaim",
        text: "access ended",
        claimId: held.claimId,
        claimEnd: "access_gone",
        by: null,
        keyName: null,
      });
      expect(tasks.store.claimById(held.claimId)).toMatchObject({
        end_reason: "access_gone",
        ended_at: app.now.value,
      });
      expect(events).toContainEqual({
        type: "externalTask.changed",
        data: {
          projectId: current.task.task.projectId,
          task: current.task.task,
        },
      });
    }
    expect(kept.map((task) => tasks.show(task.id, null))).toEqual(
      before.slice(ended.length),
    );
  } finally {
    write.mockRestore();
    stop();
  }
}

for (const who of ["owner", "admin"] as const) {
  test.serial(
    `${who} revocation ends only that key's claims in the revoke transaction`,
    async () => {
      await using f = await httpFixture();
      const key = await f.key();
      const otherKey = await f.key("other");
      const ended = [
        hold(f.app, key, f.projectId),
        hold(f.app, key, f.projectId, true),
      ];
      const kept = [hold(f.app, otherKey, f.projectId)];
      const conn = await f.connect(f.member.client);
      const act = () =>
        who === "owner"
          ? f.creator.client.call("DELETE", `/api/profile/keys/${key.keyId}`)
          : f.admin.call(
              "DELETE",
              `/api/users/${key.userId}/keys/${key.keyId}`,
            );
      await atomicEnding(f.app, act, 204, ended, kept);
      expect(
        f.app.db
          .query("select id from access_keys where id = ?")
          .get(key.keyId),
      ).toBeNull();
      expect(
        conn.frames.filter((frame) => frame.type === "externalTask"),
      ).toEqual(
        ended.map(({ id }) => ({
          type: "externalTask",
          projectId: f.projectId,
          task: f.app.externalTasks.store.byId(id)!,
        })),
      );
    },
  );
}

test.serial(
  "disabling a user ends every key's claims in the disable transaction",
  async () => {
    await using f = await httpFixture();
    const key = await f.key();
    const second = await f.key("second");
    const other = await keyFor(f.member.client, f.member.user.id);
    const personal = f.app.projects.personal(key.userId)!.id;
    const ended = [
      hold(f.app, key, f.projectId),
      hold(f.app, second, personal, true),
    ];
    const kept = [hold(f.app, other, f.projectId)];
    const conn = await f.connect(f.creator.client);
    await atomicEnding(
      f.app,
      () =>
        f.admin.call("PATCH", `/api/users/${key.userId}`, {
          body: { disabled: true },
        }),
      200,
      ended,
      kept,
    );
    expect(f.app.users.byId(key.userId)!.disabled).toBe(true);
    expect(
      f.app.db
        .query("select id from access_keys where user_id = ?")
        .all(key.userId),
    ).toEqual([]);
    expect(
      conn.frames.filter((frame) => frame.type === "externalTask"),
    ).toEqual([]);
  },
);

test.serial(
  "removing a member ends only their claims in that project's transaction",
  async () => {
    await using f = await httpFixture();
    const key = await f.key();
    const other = await keyFor(f.member.client, f.member.user.id);
    const ended = [hold(f.app, key, f.projectId, true)];
    const kept = [
      hold(f.app, key, f.app.projects.personal(key.userId)!.id),
      hold(f.app, other, f.projectId),
    ];
    const conn = await f.connect(f.creator.client);
    await atomicEnding(
      f.app,
      () =>
        f.admin.call(
          "DELETE",
          `/api/projects/${f.projectId}/members/${key.userId}`,
        ),
      200,
      ended,
      kept,
    );
    expect(f.app.projects.isMember(f.projectId, key.userId)).toBe(false);
    expect(conn.frames.filter((frame) => frame.type !== "hello")).toEqual([
      { type: "revoked", projectId: f.projectId },
    ]);
  },
);

test.serial(
  "demoting an admin ends only claims in team projects they have not joined",
  async () => {
    await using f = await httpFixture();
    const userId = f.creator.user.id;
    expect(
      (
        await f.admin.call("PATCH", `/api/users/${userId}`, {
          body: { role: "admin" },
        })
      ).status,
    ).toBe(200);
    const lost = await createTeam(f.admin, "unjoined", [f.member.user.id]);
    const alsoLost = await createTeam(f.admin, "also-unjoined", []);
    const key = await f.key();
    const other = await keyFor(f.member.client, f.member.user.id);
    const ended = [
      hold(f.app, key, lost.id, true),
      hold(f.app, key, alsoLost.id),
    ];
    const kept = [
      hold(f.app, key, f.projectId),
      hold(f.app, key, f.app.projects.personal(userId)!.id),
      hold(f.app, other, lost.id),
    ];
    const conn = await f.connect(f.creator.client);
    await atomicEnding(
      f.app,
      () =>
        f.admin.call("PATCH", `/api/users/${userId}`, {
          body: { role: "member" },
        }),
      200,
      ended,
      kept,
    );
    expect(f.app.users.byId(userId)!.role).toBe("member");
    const frames = conn.frames.filter((frame) => frame.type !== "hello");
    expect(frames).toHaveLength(3);
    expect(frames).toEqual(
      expect.arrayContaining([
        { type: "role", role: "member" },
        { type: "revoked", projectId: lost.id },
        { type: "revoked", projectId: alsoLost.id },
      ]),
    );
  },
);

test.serial(
  "an admin's password reset ends claims with the deleted keys and logins",
  async () => {
    await using f = await httpFixture();
    const key = await f.key();
    const other = await keyFor(f.member.client, f.member.user.id);
    const ended = [hold(f.app, key, f.projectId, true)];
    const kept = [hold(f.app, other, f.projectId)];
    await atomicEnding(
      f.app,
      () =>
        f.admin.call("POST", `/api/users/${key.userId}/password`, {
          body: { password: "reset-password" },
        }),
      204,
      ended,
      kept,
    );
    expect(f.app.users.byId(key.userId)!.mustChangePassword).toBe(true);
    expect(
      f.app.db
        .query("select id from access_keys where user_id = ?")
        .all(key.userId),
    ).toEqual([]);
  },
);

for (const purpose of ["reset", "invite"] as const) {
  test.serial(
    `${purpose} link use ends claims in the password transaction`,
    async () => {
      const e = await emailApp();
      const { app } = e;
      try {
        const client = app.client();
        expect((await client.login("maria", MARIA_PASSWORD)).status).toBe(200);
        const key = await keyFor(client, e.maria.id);
        const other = await keyFor(e.admin, app.users.byUsername("admin")!.id);
        const ended = [
          hold(app, key, app.projects.personal(key.userId)!.id, true),
        ];
        const kept = [
          hold(app, other, app.projects.personal(other.userId)!.id),
        ];
        if (purpose === "invite")
          app.users.setMustChangePassword(key.userId, true);
        expect(
          (
            await e.admin.call(
              "POST",
              `/api/users/${key.userId}/${purpose === "reset" ? "reset-link" : "invite"}`,
            )
          ).status,
        ).toBe(204);
        await e.send();
        const token = e.token();
        await atomicEnding(
          app,
          () =>
            app.client().call("POST", `/api/links/${token}`, {
              body: { password: "new-password" },
            }),
          200,
          ended,
          kept,
        );
        expect(e.links(key.userId)).toEqual([
          { purpose, minted: true, used: true },
        ]);
        expect(
          app.db
            .query("select id from access_keys where user_id = ?")
            .all(key.userId),
        ).toEqual([]);
      } finally {
        await app.shutdown();
        app.db.close();
      }
    },
  );
}

test("removing an admin's membership keeps claims because the project is still visible", async () => {
  await using f = await httpFixture();
  const userId = f.creator.user.id;
  expect(
    (
      await f.admin.call("PATCH", `/api/users/${userId}`, {
        body: { role: "admin" },
      })
    ).status,
  ).toBe(200);
  const held = hold(f.app, await f.key(), f.projectId);
  const before = f.app.externalTasks.show(held.id, null);
  expect(
    (
      await f.admin.call(
        "DELETE",
        `/api/projects/${f.projectId}/members/${userId}`,
      )
    ).status,
  ).toBe(200);
  expect(f.app.externalTasks.show(held.id, null)).toEqual(before);
});

test("an owner's password change keeps their keys and task claims", async () => {
  await using f = await httpFixture();
  const held = hold(f.app, await f.key(), f.projectId);
  const before = f.app.externalTasks.show(held.id, null);
  expect(
    (
      await f.creator.client.call("POST", "/api/profile/password", {
        body: { current: "pw", next: "new-password" },
      })
    ).status,
  ).toBe(200);
  expect(f.app.externalTasks.show(held.id, null)).toEqual(before);
});
