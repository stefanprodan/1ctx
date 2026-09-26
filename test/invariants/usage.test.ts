// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { DirectoryAgentDaysResponse } from "../../src/shared/api/directory.ts";
import type {
  DaysUsageResponse,
  WeekUsageResponse,
} from "../../src/shared/api/usage.ts";
import {
  type ChatApp,
  chatApp,
  FLASH,
  type Script,
  startChat,
  tick,
} from "../helpers/chat.ts";

const DAY_MS = 86_400_000;

async function finish(
  chat: ChatApp,
  script: Script,
  prompt: number,
  completion: number,
): Promise<void> {
  script.content("done");
  script.finish();
  script.usage({ prompt, completion });
  script.end();
  for (let i = 0; i < 100 && chat.app.runner.registry.size > 0; i++) {
    await tick();
  }
  expect(chat.app.runner.registry.size).toBe(0);
}

describe("GET /api/usage/week", () => {
  test("sums the last seven calendar days in the caller's zone", async () => {
    const chat = await chatApp();
    chat.app.now.value = 8 * DAY_MS;

    const old = await startChat(chat, "old");
    await finish(chat, old.script, 100, 50);

    // a millisecond before the window's first midnight: inside the last
    // 168 hours, outside the last seven calendar days
    chat.app.now.value = 9 * DAY_MS - 1;
    const edge = await startChat(chat, "edge");
    await finish(chat, edge.script, 200, 100);

    chat.app.now.value = 15 * DAY_MS + 1;
    const first = await startChat(chat, "first");
    await finish(chat, first.script, 11, 5);
    const followUpPending = chat.scripted.next();
    const followUpRes = await chat.member.call(
      "POST",
      `/api/sessions/${first.sessionId}/messages`,
      { body: { message: "follow up" } },
    );
    expect(followUpRes.status).toBe(201);
    await finish(chat, await followUpPending, 13, 6);

    const second = await startChat(chat, "second");
    await finish(chat, second.script, 17, 7);

    const adminProject = chat.app.projects.personal(chat.adminId)!.id;
    const other = await startChat(
      chat,
      "other user's chat",
      chat.admin,
      adminProject,
    );
    await finish(chat, other.script, 1_000, 500);

    const res = await chat.member.call("GET", "/api/usage/week?tz=UTC");
    expect(res.status).toBe(200);
    expect((await res.json()) as WeekUsageResponse).toEqual({
      since: 9 * DAY_MS,
      until: 16 * DAY_MS,
      // the first chat's two messages and the second's one
      sends: 3,
      sessions: 2,
      promptTokens: 41,
      completionTokens: 18,
    });
    for (const query of ["", "?tz=UTC&extra=1", "?tz=Mars/Olympus"]) {
      expect(
        (await chat.member.call("GET", `/api/usage/week${query}`)).status,
      ).toBe(400);
    }

    await chat.app.shutdown();
  });
});

describe("GET /api/usage/days", () => {
  test("returns the fixed window with zero-filled visible projects", async () => {
    const chat = await chatApp();
    chat.app.now.value = Date.parse("2026-09-16T12:00:00Z");
    expect((await chat.member.login("casey", "pw")).status).toBe(200);
    expect((await chat.admin.login("admin", "hunter2-test")).status).toBe(200);
    const visible = chat.app.projects.createTeam({
      ownerId: chat.adminId,
      name: "visible-team",
      description: "",
      now: chat.app.now.value,
    });
    chat.app.projects.addMember(visible.id, chat.memberId, chat.app.now.value);
    const hidden = chat.app.projects.createTeam({
      ownerId: chat.adminId,
      name: "hidden-team",
      description: "",
      now: chat.app.now.value,
    });

    const memberRes = await chat.member.call("GET", "/api/usage/days?tz=UTC");
    expect(memberRes.status).toBe(200);
    const member = (await memberRes.json()) as DaysUsageResponse;
    expect(member.since).toBe(Date.parse("2025-09-15T00:00:00Z"));
    expect(member.until).toBe(Date.parse("2026-09-17T00:00:00Z"));
    expect(member.days).toHaveLength(367);
    expect(member.days[0]).toBe("2025-09-15");
    expect(member.days.at(-1)).toBe("2026-09-16");

    // Home's aside asks for fewer weeks: the same days, from a later Monday
    const recentRes = await chat.member.call(
      "GET",
      "/api/usage/days?tz=UTC&weeks=16",
    );
    const recent = (await recentRes.json()) as DaysUsageResponse;
    expect(recent.days).toHaveLength(15 * 7 + 3);
    expect(recent.days[0]).toBe("2026-06-01");
    expect(recent.until).toBe(member.until);
    expect(recent.days).toEqual(member.days.slice(-recent.days.length));
    expect(member.total).toEqual({ sends: 0, tokens: 0 });
    expect(member.projects.map((project) => project.projectId)).toContain(
      chat.projectId,
    );
    expect(member.projects.map((project) => project.projectId)).toContain(
      visible.id,
    );
    expect(member.projects.map((project) => project.projectId)).not.toContain(
      hidden.id,
    );
    for (const project of member.projects) {
      expect(project.usage).toHaveLength(member.days.length);
      expect(
        project.usage.every((day) => day.sends === 0 && day.tokens === 0),
      ).toBe(true);
    }

    const adminRes = await chat.admin.call("GET", "/api/usage/days?tz=UTC");
    expect(adminRes.status).toBe(200);
    const admin = (await adminRes.json()) as DaysUsageResponse;
    expect(admin.projects.map((project) => project.projectId)).toContain(
      hidden.id,
    );
    expect(admin.projects.map((project) => project.projectId)).not.toContain(
      chat.projectId,
    );

    await chat.app.shutdown();
  });

  test("places a round that crosses midnight on the later day", async () => {
    const chat = await chatApp();
    chat.app.now.value = Date.parse("2026-09-15T23:59:30Z");
    expect((await chat.member.login("casey", "pw")).status).toBe(200);
    const started = await startChat(chat, "cross midnight");
    chat.app.now.value = Date.parse("2026-09-16T00:00:30Z");
    await finish(chat, started.script, 11, 5);

    const res = await chat.member.call("GET", "/api/usage/days?tz=UTC");
    expect(res.status).toBe(200);
    const body = (await res.json()) as DaysUsageResponse;
    const project = body.projects.find(
      (candidate) => candidate.projectId === chat.projectId,
    )!;
    const before = body.days.indexOf("2026-09-15");
    const after = body.days.indexOf("2026-09-16");
    expect(project.usage[before]).toEqual({ sends: 0, tokens: 0 });
    expect(project.usage[after]).toEqual({ sends: 1, tokens: 16 });
    expect(body.total).toEqual({ sends: 1, tokens: 16 });

    await chat.app.shutdown();
  });

  // the query rules are parseDaysUsageQuery's table; one of each family here
  test("answers 400 to a malformed timezone or weeks query", async () => {
    const chat = await chatApp();
    for (const path of [
      "/api/usage/days?tz=Mars%2FOlympus",
      "/api/usage/days?tz=UTC&weeks=54",
    ]) {
      expect((await chat.member.call("GET", path)).status, path).toBe(400);
    }
    await chat.app.shutdown();
  });
});

describe("GET /api/directory/agents/:name/days", () => {
  test("counts the agent's turns in every project, as one series", async () => {
    const chat = await chatApp();
    chat.app.now.value = Date.parse("2026-09-16T10:00:00Z");
    expect((await chat.member.login("casey", "pw")).status).toBe(200);
    expect((await chat.admin.login("admin", "hunter2-test")).status).toBe(200);

    const mine = await startChat(chat, "mine");
    await finish(chat, mine.script, 11, 5);
    // the admin's personal project, which the member cannot see
    const adminProject = chat.app.projects.personal(chat.adminId)!.id;
    const theirs = await startChat(chat, "theirs", chat.admin, adminProject);
    await finish(chat, theirs.script, 100, 50);
    // another agent's turn is not this one's
    const otherId = await chat.makeAgent({ name: "other", model: FLASH });
    const other = await startChat(
      chat,
      "other agent",
      chat.member,
      chat.projectId,
      otherId,
    );
    await finish(chat, other.script, 1_000, 500);

    const res = await chat.member.call(
      "GET",
      "/api/directory/agents/coder/days?tz=UTC",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as DirectoryAgentDaysResponse;
    expect(Object.keys(body).sort()).toEqual([
      "days",
      "since",
      "total",
      "until",
      "usage",
    ]);
    expect(body.since).toBe(Date.parse("2025-09-15T00:00:00Z"));
    expect(body.until).toBe(Date.parse("2026-09-17T00:00:00Z"));
    expect(body.days).toHaveLength(367);
    expect(body.usage).toHaveLength(body.days.length);
    expect(body.usage.at(-1)).toEqual({ sends: 2, tokens: 166 });
    expect(body.usage.slice(0, -1).every((d) => d.sends === 0)).toBe(true);
    expect(body.total).toEqual({ sends: 2, tokens: 166 });

    await chat.app.shutdown();
  });

  test("counts a send across midnight once in the total", async () => {
    const chat = await chatApp();
    chat.app.now.value = Date.parse("2026-09-15T23:59:30Z");
    expect((await chat.member.login("casey", "pw")).status).toBe(200);
    const started = await startChat(chat, "cross midnight");
    chat.app.now.value = Date.parse("2026-09-16T00:00:30Z");
    await finish(chat, started.script, 11, 5);

    const res = await chat.member.call(
      "GET",
      "/api/directory/agents/coder/days?tz=UTC",
    );
    const body = (await res.json()) as DirectoryAgentDaysResponse;
    expect(body.usage[body.days.indexOf("2026-09-16")]).toEqual({
      sends: 1,
      tokens: 16,
    });
    expect(body.total).toEqual({ sends: 1, tokens: 16 });

    await chat.app.shutdown();
  });

  test("answers 404 to a stranger and 400 to a bad zone or query", async () => {
    const chat = await chatApp();
    expect((await chat.member.login("casey", "pw")).status).toBe(200);
    const cases: [string, number][] = [
      ["/api/directory/agents/nobody/days?tz=UTC", 404],
      ["/api/directory/agents/coder/days", 400],
      ["/api/directory/agents/coder/days?tz=Mars%2FOlympus", 400],
      ["/api/directory/agents/coder/days?tz=UTC&weeks=16", 400],
    ];
    for (const [path, status] of cases) {
      expect((await chat.member.call("GET", path)).status, path).toBe(status);
    }
    await chat.app.shutdown();
  });
});
