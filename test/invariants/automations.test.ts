// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { nextFire, nextFires } from "../../src/server/automations/index.ts";
import { type BusEvent, subscribe } from "../../src/server/lib/bus.ts";
import { silent } from "../../src/server/lib/log.ts";
import type { StreamRow } from "../../src/shared/api/sessions.ts";
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
    const stream = await (
      await chat.member.call("GET", "/api/sessions?origin=automation")
    ).json();
    expect(stream.rows.map((row: StreamRow) => row.session.id)).toEqual([
      detail.session.id,
    ]);
    // the row names its agent, credited on a line of a send that ended
    expect(stream.rows[0].agent).toBe("coder");
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
      { body: { tz: "UTC" } },
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
            (row: StreamRow) => row.session.id === scheduled!.session.id,
          ).session.runSource,
        ).toBe("schedule");
        expect(
          runs.rows.find(
            (row: StreamRow) => row.session.id === manual.session.id,
          ).session.runSource,
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

    const failed = await (
      await chat.member.call(
        "GET",
        `/api/automations/${automation.id}/runs?filter=failed`,
      )
    ).json();
    expect(failed.rows.map((row: StreamRow) => row.session.id).sort()).toEqual([
      "run-failed-manual",
      "run-failed-schedule",
    ]);
    expect(failed.tally).toEqual({
      running: 1,
      done: 1,
      failed: 2,
      stopped: 1,
    });

    const manual = await (
      await chat.member.call(
        "GET",
        `/api/automations/${automation.id}/runs?filter=manual`,
      )
    ).json();
    expect(manual.rows.map((row: StreamRow) => row.session.id).sort()).toEqual([
      "run-done",
      "run-failed-manual",
    ]);
    expect(manual.tally).toEqual(failed.tally);
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
  test("lets project operators run and suspend but only owners and admins edit", async () => {
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
        },
      },
    );
    const automation = (await created.json()).automation;
    const otherClient = chat.app.client();
    await otherClient.login("other", "pw");
    expect(
      (
        await otherClient.call("PATCH", `/api/automations/${automation.id}`, {
          body: { instructions: "change", memoryGuidance: "change" },
        })
      ).status,
    ).toBe(403);
    expect(chat.app.automations.byId(automation.id)?.memoryGuidance).toBe("");
    expect(
      (await otherClient.call("DELETE", `/api/automations/${automation.id}`))
        .status,
    ).toBe(403);
    const suspended = await otherClient.call(
      "POST",
      `/api/automations/${automation.id}/suspend`,
    );
    expect(suspended.status).toBe(200);
    // the row names who suspended it, and a resume clears the name
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
    expect((await resumed.json()).automation.suspendedBy).toBeNull();

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
        .map((r: StreamRow) => [r.session.ownerId, r.runBy])
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
    expect((await adminSuspend.json()).automation.suspendedBy).toEqual({
      id: chat.adminId,
      username: "admin",
    });

    expect(
      (
        await chat.admin.call("PATCH", `/api/automations/${automation.id}`, {
          body: { instructions: "admin change" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await chat.admin.call("DELETE", `/api/automations/${automation.id}`))
        .status,
    ).toBe(204);

    const personal = await createAutomation(chat, { name: "private-run" });
    expect(
      (await chat.admin.call("GET", `/api/automations/${personal.id}`)).status,
    ).toBe(404);
    await chat.app.shutdown();
  });
});
