// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { nextFire, nextFires } from "../../src/server/automations/index.ts";
import { type BusEvent, subscribe } from "../../src/server/lib/bus.ts";
import { silent } from "../../src/server/lib/log.ts";
import type { FeedRow } from "../../src/shared/api/sessions.ts";
import {
  type AutomationSummary,
  STALE_EDIT,
} from "../../src/shared/contracts/automation.ts";
import { hashPassword } from "../helpers/app.ts";
import { createAutomation } from "../helpers/automations.ts";
import { chatApp, tick } from "../helpers/chat.ts";

async function settle(
  chat: Awaited<ReturnType<typeof chatApp>>,
  sessionId: string,
) {
  for (let i = 0; i < 100; i++) {
    if (chat.app.sessions.byId(sessionId)?.status !== "running") return;
    await tick();
  }
  throw new Error("run did not settle");
}

describe("automations", () => {
  test("creates, operates, runs, lists, and guards a run", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat);
    expect(automation).toMatchObject({
      projectId: chat.projectId,
      ownerId: chat.memberId,
      agentId: chat.agentId,
      name: "daily-run",
      suspendedAt: null,
      lastRunSessionId: null,
    });
    expect(automation.nextAt).toBeGreaterThan(chat.app.now.value);

    const listed = await chat.member.call(
      "GET",
      `/api/projects/${chat.projectId}/automations`,
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      automations: [{ id: automation.id }],
      runDeadlineMs: expect.any(Number),
    });

    const pending = chat.scripted.next();
    const response = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/run`,
    );
    expect(response.status).toBe(201);
    const detail = await response.json();
    const script = await pending;
    expect(detail.session).toMatchObject({
      origin: "automation",
      automationId: automation.id,
      ownerId: chat.memberId,
      title: automation.name,
    });
    expect(detail.send.kind).toBe("run");
    expect(detail.messages[0].content).toBe("check the system");

    for (const action of ["messages", "regenerate", "compact"]) {
      const guarded =
        action === "messages"
          ? await chat.member.call(
              "POST",
              `/api/sessions/${detail.session.id}/messages`,
              { body: { message: "continue" } },
            )
          : await chat.member.call(
              "POST",
              `/api/sessions/${detail.session.id}/${action}`,
            );
      expect(guarded.status).toBe(409);
    }
    expect(
      (await chat.member.call("DELETE", `/api/automations/${automation.id}`))
        .status,
    ).toBe(409);

    script.reply("healthy");
    await settle(chat, detail.session.id);
    const current = chat.app.automations.byId(automation.id)!;
    expect(current.lastRunStatus).toBe("done");
    expect(current.lastRunSessionId).toBe(detail.session.id);

    const runs = await (
      await chat.member.call("GET", `/api/automations/${automation.id}/runs`)
    ).json();
    expect(runs.rows[0]).toMatchObject({
      automation: { id: automation.id, name: automation.name },
      session: { id: detail.session.id, origin: "automation" },
    });
    const feed = await (
      await chat.member.call("GET", "/api/sessions?origin=automation")
    ).json();
    expect(feed.rows.map((row: FeedRow) => row.session.id)).toEqual([
      detail.session.id,
    ]);
    // the row names its agent, credited on a line of a send that ended
    expect(feed.rows[0].agent).toBe("coder");
    expect(
      (await chat.member.call("GET", "/api/sessions?origin=chat")).json(),
    ).resolves.toMatchObject({ rows: [] });

    expect(
      (
        await chat.member.call(
          "POST",
          `/api/automations/${automation.id}/suspend`,
        )
      ).status,
    ).toBe(200);
    expect(chat.app.automations.byId(automation.id)?.nextAt).toBeNull();
    chat.app.automationScheduler.stop();
    await tick();
    chat.app.now.value = Date.parse("2026-03-08T06:30:00.000Z");
    await chat.member.login("casey", "pw");
    const changedSchedule = await chat.member.call(
      "PATCH",
      `/api/automations/${automation.id}`,
      {
        body: {
          editRevision: chat.app.automations.byId(automation.id)!.editRevision,
          schedule: "0 2 * * *",
          tz: "America/New_York",
        },
      },
    );
    expect(changedSchedule.status).toBe(200);
    expect(chat.app.automations.byId(automation.id)?.nextAt).toBeNull();
    expect(
      (
        await chat.member.call(
          "POST",
          `/api/automations/${automation.id}/resume`,
        )
      ).status,
    ).toBe(200);
    expect(chat.app.automations.byId(automation.id)?.nextAt).toBe(
      nextFire("0 2 * * *", "America/New_York", chat.app.now.value),
    );
    const beforeZoneEdit = chat.app.automations.byId(automation.id)?.nextAt;
    const changedZone = await chat.member.call(
      "PATCH",
      `/api/automations/${automation.id}`,
      {
        body: {
          editRevision: chat.app.automations.byId(automation.id)!.editRevision,
          tz: "UTC",
        },
      },
    );
    expect(changedZone.status).toBe(200);
    expect(chat.app.automations.byId(automation.id)?.nextAt).toBe(
      nextFire("0 2 * * *", "UTC", chat.app.now.value),
    );
    expect(chat.app.automations.byId(automation.id)?.nextAt).not.toBe(
      beforeZoneEdit,
    );
    expect(
      (await chat.member.call("DELETE", `/api/automations/${automation.id}`))
        .status,
    ).toBe(204);
    expect(chat.app.sessions.byId(detail.session.id)?.automationId).toBeNull();
    await chat.app.shutdown();
  });

  test.serial(
    "records scheduled and manual run sources on every session word",
    async () => {
      const chat = await chatApp();
      const automation = await createAutomation(chat);
      chat.app.automationScheduler.stop();
      await tick();
      const seen: Extract<BusEvent, { type: "session.changed" }>["data"][] = [];
      const off = subscribe((event) => {
        if (event.type === "session.changed") seen.push(event.data);
      }, silent);
      try {
        chat.app.now.value = automation.nextAt!;
        const scheduledPending = chat.scripted.next();
        const scheduled = await chat.app.automationScheduler.fire(
          automation.id,
        );
        const scheduledScript = await scheduledPending;
        expect(scheduled?.session.runSource).toBe("schedule");
        scheduledScript.reply("scheduled");
        await settle(chat, scheduled!.session.id);

        const manualPending = chat.scripted.next();
        const manualResponse = await chat.member.call(
          "POST",
          `/api/automations/${automation.id}/run`,
        );
        const manual = await manualResponse.json();
        const manualScript = await manualPending;
        expect(manual.session.runSource).toBe("manual");
        manualScript.reply("manual");
        await settle(chat, manual.session.id);

        const runs = await (
          await chat.member.call(
            "GET",
            `/api/automations/${automation.id}/runs`,
          )
        ).json();
        expect(
          runs.rows.find(
            (row: FeedRow) => row.session.id === scheduled!.session.id,
          ).session.runSource,
        ).toBe("schedule");
        expect(
          runs.rows.find((row: FeedRow) => row.session.id === manual.session.id)
            .session.runSource,
        ).toBe("manual");
        expect(
          seen.find((event) => event.session.id === scheduled!.session.id)
            ?.session.runSource,
        ).toBe("schedule");
        expect(
          seen.find((event) => event.session.id === manual.session.id)?.session
            .runSource,
        ).toBe("manual");
      } finally {
        off();
        await chat.app.shutdown();
      }
    },
  );

  test("filters runs while keeping an unfiltered status tally", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat);
    const rows = [
      ["run-running", "running", "schedule"],
      ["run-done", "done", "manual"],
      ["run-failed-schedule", "failed", "schedule"],
      ["run-failed-manual", "failed", "manual"],
      ["run-stopped", "stopped", "schedule"],
    ] as const;
    for (const [id, status, runSource] of rows) {
      chat.app.sessions.create({
        id,
        projectId: chat.projectId,
        ownerId: chat.memberId,
        agentId: chat.agentId,
        origin: "automation",
        automationId: automation.id,
        runSource,
        title: automation.name,
        now: chat.app.now.value,
      });
      if (status !== "running") {
        chat.app.sessions.touch(id, { status, now: chat.app.now.value });
      }
    }

    // failures are flagged, so there is no failed filter
    expect(
      (
        await chat.member.call(
          "GET",
          `/api/automations/${automation.id}/runs?filter=failed`,
        )
      ).status,
    ).toBe(400);

    const manual = await (
      await chat.member.call(
        "GET",
        `/api/automations/${automation.id}/runs?filter=manual`,
      )
    ).json();
    expect(manual.rows.map((row: FeedRow) => row.session.id).sort()).toEqual([
      "run-done",
      "run-failed-manual",
    ]);
    expect(manual.tally).toEqual({
      running: 1,
      done: 1,
      failed: 2,
      stopped: 1,
    });
    expect(manual.next).toBeNull();
    for (const before of ["0.1.abc123def456", "1.bad", "-1.abc123def456"]) {
      expect(
        (
          await chat.member.call(
            "GET",
            `/api/automations/${automation.id}/runs?before=${before}`,
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await chat.member.call(
          "GET",
          `/api/automations/${automation.id}/runs?filter=stopped`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await chat.member.call(
          "GET",
          `/api/automations/${automation.id}/runs?other=failed`,
        )
      ).status,
    ).toBe(400);
    await chat.app.shutdown();
  });

  test("previews validated schedules for visible projects", async () => {
    const chat = await chatApp();
    const query = new URLSearchParams({
      schedule: "0 9 * * *",
      tz: "Europe/Bucharest",
    });
    const preview = await chat.member.call(
      "GET",
      `/api/projects/${chat.projectId}/automations/preview?${query}`,
    );
    expect(preview.status).toBe(200);
    const body = await preview.json();
    expect(body.fires).toEqual(
      nextFires("0 9 * * *", "Europe/Bucharest", chat.app.now.value, 5),
    );
    expect(body.fires).toHaveLength(5);
    expect(body.fires).toEqual([...body.fires].sort((a, b) => a - b));

    for (const fields of [
      { schedule: "0 9 * * *", tz: "Not/AZone" },
      { schedule: "* * * * *", tz: "UTC" },
      { schedule: "0 0 30 2 *", tz: "UTC" },
    ]) {
      const invalid = new URLSearchParams(fields);
      expect(
        (
          await chat.member.call(
            "GET",
            `/api/projects/${chat.projectId}/automations/preview?${invalid}`,
          )
        ).status,
      ).toBe(400);
    }
    const hidden = chat.app.projects.personal(chat.adminId)!;
    expect(
      (
        await chat.member.call(
          "GET",
          `/api/projects/${hidden.id}/automations/preview?${query}`,
        )
      ).status,
    ).toBe(404);
    await chat.app.shutdown();
  });

  test("keeps names unique and caps a project", async () => {
    const chat = await chatApp();
    await createAutomation(chat, { name: "same-name" });
    const duplicate = await chat.member.call(
      "POST",
      `/api/projects/${chat.projectId}/automations`,
      {
        body: {
          name: "same-name",
          agentId: chat.agentId,
          instructions: "check",
          schedule: "0 * * * *",
          tz: "UTC",
          deadlineMs: null,
          retentionDays: 30,
          ownMemory: false,
        },
      },
    );
    expect(duplicate.status).toBe(409);
    for (let i = 1; i < 20; i++) {
      await createAutomation(chat, { name: `run-${i}` });
    }
    const over = await chat.member.call(
      "POST",
      `/api/projects/${chat.projectId}/automations`,
      {
        body: {
          name: "one-too-many",
          agentId: chat.agentId,
          instructions: "check",
          schedule: "0 * * * *",
          tz: "UTC",
          deadlineMs: null,
          retentionDays: 30,
          ownMemory: false,
        },
      },
    );
    expect(over.status).toBe(409);
    await chat.app.shutdown();
  });
});

describe("automation rights", () => {
  // a team project with the member casey and another member, other, and
  // a task casey made
  async function teamApp() {
    const chat = await chatApp();
    const other = chat.app.createUser({
      username: "other",
      fullName: "Other User",
      email: "other@example.com",
      role: "member",
      passwordHash: await hashPassword("pw"),
      mustChangePassword: false,
      now: chat.app.now.value,
    });
    chat.app.db
      .query(
        "insert into projects (id, kind, name, owner_id, created_at) values ('team-auto', 'team', 'team-auto', ?, ?)",
      )
      .run(chat.memberId, chat.app.now.value);
    for (const userId of [chat.memberId, other.id]) {
      chat.app.db
        .query(
          "insert into memberships (project_id, user_id, created_at) values ('team-auto', ?, ?)",
        )
        .run(userId, chat.app.now.value);
    }
    const created = await chat.member.call(
      "POST",
      "/api/projects/team-auto/automations",
      {
        body: {
          name: "team-run",
          agentId: chat.agentId,
          instructions: "check",
          schedule: "0 * * * *",
          tz: "UTC",
          deadlineMs: null,
          retentionDays: 30,
          ownMemory: false,
          // its runs ask no attention step of the scripted provider
          attentionMode: "off",
        },
      },
    );
    const automation: AutomationSummary = (await created.json()).automation;
    const otherClient = chat.app.client();
    await otherClient.login("other", "pw");
    const row = () => chat.app.automations.byId(automation.id)!;
    const patch = (
      client: typeof otherClient,
      body: Record<string, unknown>,
      editRevision = row().editRevision,
    ) =>
      client.call("PATCH", `/api/automations/${automation.id}`, {
        body: { ...body, editRevision },
      });
    return { chat, other, otherClient, automation, row, patch };
  }

  test("lets every project member run, suspend, edit and delete", async () => {
    const { chat, other, otherClient, automation, row, patch } =
      await teamApp();
    const suspended = await otherClient.call(
      "POST",
      `/api/automations/${automation.id}/suspend`,
    );
    expect(suspended.status).toBe(200);
    // the row names who suspended it, and a resume clears the name;
    // neither moves the owner
    const suspendedRow = (await suspended.json()).automation;
    expect(suspendedRow.suspendedBy).toEqual({
      id: other.id,
      username: "other",
    });
    expect(suspendedRow.ownerName).toBe("casey");
    const resumed = await otherClient.call(
      "POST",
      `/api/automations/${automation.id}/resume`,
    );
    expect((await resumed.json()).automation).toMatchObject({
      suspendedBy: null,
      ownerId: chat.memberId,
    });
    const dismissed = await otherClient.call(
      "POST",
      `/api/automations/${automation.id}/dismiss`,
    );
    expect((await dismissed.json()).automation.ownerId).toBe(chat.memberId);

    const pending = chat.scripted.next();
    const run = await otherClient.call(
      "POST",
      `/api/automations/${automation.id}/run`,
    );
    const detail = await run.json();
    const script = await pending;
    expect(detail.session.ownerId).toBe(other.id);
    script.reply("done");
    await settle(chat, detail.session.id);
    expect(row().ownerId).toBe(chat.memberId);

    // an admin outside the project is named on what they do: the run
    // they start and the suspend they press
    const adminPending = chat.scripted.next();
    const adminRun = await (
      await chat.admin.call("POST", `/api/automations/${automation.id}/run`)
    ).json();
    (await adminPending).reply("done");
    await settle(chat, adminRun.session.id);
    const listed = await (
      await otherClient.call(
        "GET",
        `/api/automations/${automation.id}/runs?filter=manual`,
      )
    ).json();
    expect(
      listed.rows
        .map((r: FeedRow) => [r.session.ownerId, r.runBy])
        .sort((a: [string], b: [string]) => a[0].localeCompare(b[0])),
    ).toEqual(
      [
        [chat.adminId, { id: chat.adminId, username: "admin" }],
        [other.id, { id: other.id, username: "other" }],
      ].sort((a, b) => (a[0] as string).localeCompare(b[0] as string)),
    );
    const adminSuspend = await chat.admin.call(
      "POST",
      `/api/automations/${automation.id}/suspend`,
    );
    expect((await adminSuspend.json()).automation).toMatchObject({
      suspendedBy: { id: chat.adminId, username: "admin" },
      ownerId: chat.memberId,
    });

    // a member's save makes them the owner
    const edited = await patch(otherClient, {
      instructions: "change",
      memoryGuidance: "change",
    });
    expect(edited.status).toBe(200);
    expect((await edited.json()).automation).toMatchObject({
      ownerId: other.id,
      ownerName: "other",
      instructions: "change",
      memoryGuidance: "change",
      editRevision: 1,
    });
    // so does an admin outside the team project
    const adminEdit = await patch(chat.admin, { instructions: "admin change" });
    expect(adminEdit.status).toBe(200);
    expect(row()).toMatchObject({
      ownerId: chat.adminId,
      instructions: "admin change",
      editRevision: 2,
    });
    // lowering retention is any member's too
    expect((await patch(otherClient, { retentionDays: 1 })).status).toBe(200);
    expect(row()).toMatchObject({ ownerId: other.id, retentionDays: 1 });
    expect(
      (await otherClient.call("DELETE", `/api/automations/${automation.id}`))
        .status,
    ).toBe(204);
    expect(chat.app.automations.byId(automation.id)).toBeNull();
    await chat.app.shutdown();
  });

  test("moves the owner only on a change", async () => {
    const { chat, other, otherClient, row, patch } = await teamApp();
    const before = row();
    // every field as it is: no write, the owner stays
    const same = await patch(otherClient, {
      name: before.name,
      instructions: before.instructions,
      schedule: before.schedule,
      tz: before.tz,
      deadlineMs: before.deadlineMs,
      retentionDays: before.retentionDays,
      disabledCapabilities: before.disabledCapabilities,
    });
    expect(same.status).toBe(200);
    expect(row()).toEqual(before);
    const changed = await patch(otherClient, { instructions: "check again" });
    expect(changed.status).toBe(200);
    expect(row()).toMatchObject({
      ownerId: other.id,
      editRevision: before.editRevision + 1,
      revision: before.revision + 1,
    });
    await chat.app.shutdown();
  });

  test("refuses an edit made on a row someone else saved since", async () => {
    const { chat, otherClient, row, patch } = await teamApp();
    const opened = row().editRevision;
    expect(
      (await patch(chat.member, { instructions: "casey's" }, opened)).status,
    ).toBe(200);
    const after = row();
    const stale = await patch(otherClient, { name: "other-run" }, opened);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: STALE_EDIT });
    expect(row()).toEqual(after);
    await chat.app.shutdown();
  });

  test("keeps an edit good across a fire and a run's end", async () => {
    const { chat, other, otherClient, automation, row, patch } =
      await teamApp();
    chat.app.automationScheduler.stop();
    await tick();
    const opened = row();
    chat.app.now.value = opened.nextAt!;
    const pending = chat.scripted.next();
    const fired = await chat.app.automationScheduler.fire(automation.id);
    const script = await pending;
    expect(fired?.session.ownerId).toBe(chat.memberId);
    // the fire moved the revision, never the edit revision
    expect(row().revision).toBeGreaterThan(opened.revision);
    expect(row().editRevision).toBe(opened.editRevision);

    // a save while the run goes moves the owner of the runs after it,
    // never of the one going
    const saved = await patch(
      otherClient,
      { instructions: "check again" },
      opened.editRevision,
    );
    expect(saved.status).toBe(200);
    expect(row().ownerId).toBe(other.id);
    expect(chat.app.sessions.byId(fired!.session.id)?.ownerId).toBe(
      chat.memberId,
    );
    script.reply("done");
    await settle(chat, fired!.session.id);
    expect(chat.app.sessions.byId(fired!.session.id)?.ownerId).toBe(
      chat.memberId,
    );

    chat.app.now.value = row().nextAt!;
    const nextPending = chat.scripted.next();
    const next = await chat.app.automationScheduler.fire(automation.id);
    const nextScript = await nextPending;
    expect(next?.session.ownerId).toBe(other.id);
    expect(next?.messages[0]?.content).toBe("check again");
    nextScript.reply("done");
    await settle(chat, next!.session.id);
    await chat.app.shutdown();
  });

  test("keeps a task of a project the caller cannot see hidden", async () => {
    const chat = await chatApp();
    const personal = await createAutomation(chat, { name: "private-run" });
    const path = `/api/automations/${personal.id}`;
    expect((await chat.admin.call("GET", path)).status).toBe(404);
    expect(
      (
        await chat.admin.call("PATCH", path, {
          body: { instructions: "admin change", editRevision: 0 },
        })
      ).status,
    ).toBe(404);
    expect((await chat.admin.call("DELETE", path)).status).toBe(404);
    expect(chat.app.automations.byId(personal.id)).toEqual(personal);
    await chat.app.shutdown();
  });
});
