// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { nextFire } from "../../src/server/automations/index.ts";
import { hashPassword } from "../../src/server/users/index.ts";
import type { StreamRow } from "../../src/shared/api/sessions.ts";
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
    expect(
      (await chat.admin.call("DELETE", `/api/agents/${chat.agentId}`)).status,
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
    await chat.member.login("caelea", "pw");
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
        },
      },
    );
    const automation = (await created.json()).automation;
    const otherClient = chat.app.client();
    await otherClient.login("other", "pw");
    expect(
      (
        await otherClient.call("PATCH", `/api/automations/${automation.id}`, {
          body: { instructions: "change" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await otherClient.call("DELETE", `/api/automations/${automation.id}`))
        .status,
    ).toBe(403);
    expect(
      (
        await otherClient.call(
          "POST",
          `/api/automations/${automation.id}/suspend`,
        )
      ).status,
    ).toBe(200);
    await otherClient.call("POST", `/api/automations/${automation.id}/resume`);

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
