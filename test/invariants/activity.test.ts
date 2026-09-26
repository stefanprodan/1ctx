// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user's page counts their actions per day in every project as one
// series: the messages they wrote in chats, the chats and manual runs
// they started, and one for each day they were signed in.

import { describe, expect, test } from "bun:test";
import type { DirectoryUserDaysResponse } from "../../src/shared/api/directory.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  startChat,
  tick,
} from "../helpers/chat.ts";

const DAY = 86_400_000;

async function finish(chat: ChatApp, script: Script): Promise<void> {
  script.content("done");
  script.finish();
  script.end();
  for (let i = 0; i < 100 && chat.app.runner.registry.size > 0; i++) {
    await tick();
  }
  expect(chat.app.runner.registry.size).toBe(0);
}

async function days(chat: ChatApp, username = "casey") {
  const res = await chat.member.call(
    "GET",
    `/api/directory/users/${username}/days`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as DirectoryUserDaysResponse;
}

const visits = (chat: ChatApp, userId: string) =>
  chat.app.db
    .query<{ day: string; at: number }, [string]>(
      "select day, at from visits where user_id = ? order by day",
    )
    .all(userId);

describe("GET /api/directory/users/:username/days", () => {
  test("counts posts, chats, manual runs and the signed-in day", async () => {
    const chat = await chatApp();
    chat.app.now.value = Date.parse("2026-09-16T10:00:00Z");
    expect((await chat.member.login("casey", "pw")).status).toBe(200);
    expect((await chat.admin.login("admin", "hunter2-test")).status).toBe(200);

    // a chat and its first post, then a second post
    const started = await startChat(chat, "first");
    await finish(chat, started.script);
    const pending = chat.scripted.next();
    const sent = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/messages`,
      { body: { message: "second" } },
    );
    expect(sent.status).toBe(201);
    await finish(chat, await pending);

    // a fork is a chat; the posts it copies were counted where written
    const detail = await (
      await chat.member.call("GET", `/api/sessions/${started.sessionId}`)
    ).json();
    const last = detail.messages.at(-1).id as string;
    chat.app.now.value += 60_000;
    const forked = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/fork`,
      { body: { messageId: last, agentId: chat.agentId } },
    );
    expect(forked.status).toBe(201);

    // a run started by hand counts; a scheduled one is the automation's
    for (const runSource of ["manual", "schedule"] as const) {
      chat.app.sessions.create({
        projectId: chat.projectId,
        ownerId: chat.memberId,
        agentId: chat.agentId,
        origin: "automation",
        runSource,
        title: runSource,
        now: chat.app.now.value,
      });
    }

    // another person's chat is theirs
    const adminProject = chat.app.projects.personal(chat.adminId)!.id;
    const theirs = await startChat(chat, "theirs", chat.admin, adminProject);
    await finish(chat, theirs.script);

    const body = await days(chat);
    expect(Object.keys(body).sort()).toEqual([
      "days",
      "since",
      "total",
      "until",
      "usage",
    ]);
    expect(body.days).toHaveLength(367);
    expect(body.usage).toHaveLength(body.days.length);
    // two chats, two posts, one manual run, one signed-in day
    expect(body.usage.at(-1)).toBe(6);
    expect(body.usage.slice(0, -1).every((n) => n === 0)).toBe(true);
    expect(body.total).toBe(6);

    await chat.app.shutdown();
  });

  test("writes a visit once per day in the person's zone", async () => {
    const chat = await chatApp();
    chat.app.users.setTz(chat.memberId, "Asia/Tokyo");
    // 23:30 in Tokyo on the 15th
    chat.app.now.value = Date.parse("2026-09-15T14:30:00Z");
    expect((await chat.member.login("casey", "pw")).status).toBe(200);
    await chat.member.call("GET", "/api/me");
    chat.app.now.value += 10 * 60_000;
    await chat.member.call("GET", "/api/me");
    // past midnight in Tokyo: a new day
    chat.app.now.value += 30 * 60_000;
    await chat.member.call("GET", "/api/me");
    await chat.member.call("GET", "/api/me");

    expect(visits(chat, chat.memberId)).toEqual([
      { day: "2026-09-15", at: Date.parse("2026-09-15T14:30:00Z") },
      { day: "2026-09-16", at: Date.parse("2026-09-15T15:10:00Z") },
    ]);
    // the days are the person's, so each visit is on its own day
    const body = await days(chat);
    expect(body.days.at(-1)).toBe("2026-09-16");
    expect(body.usage.slice(-2)).toEqual([1, 1]);
    expect(body.total).toBe(2);

    await chat.app.shutdown();
  });

  test("the sweep drops visits past every window", async () => {
    const chat = await chatApp();
    chat.app.now.value = Date.parse("2026-09-16T10:00:00Z");
    expect((await chat.member.login("casey", "pw")).status).toBe(200);
    await chat.member.call("GET", "/api/me");
    expect(visits(chat, chat.memberId)).toHaveLength(1);

    chat.app.now.value += 399 * DAY;
    chat.app.sweep();
    expect(visits(chat, chat.memberId)).toHaveLength(1);
    chat.app.now.value += 2 * DAY;
    chat.app.sweep();
    expect(visits(chat, chat.memberId)).toHaveLength(0);

    await chat.app.shutdown();
  });

  test("counts in the person's zone whatever the caller's", async () => {
    const chat = await chatApp();
    chat.app.users.setTz(chat.memberId, "Asia/Tokyo");
    // 01:00 on the 16th in Tokyo, still the 15th in UTC
    chat.app.now.value = Date.parse("2026-09-15T16:00:00Z");
    expect((await chat.member.login("casey", "pw")).status).toBe(200);
    expect((await chat.admin.login("admin", "hunter2-test")).status).toBe(200);
    const started = await startChat(chat, "late");
    await finish(chat, started.script);

    const res = await chat.admin.call("GET", "/api/directory/users/casey/days");
    const body = (await res.json()) as DirectoryUserDaysResponse;
    expect(body.days.at(-1)).toBe("2026-09-16");
    expect(body.since).toBe(Date.parse("2025-09-14T15:00:00Z"));
    // the chat, its post and the signed-in day
    expect(body.usage.at(-1)).toBe(3);
    expect(body.total).toBe(3);

    // a zone the runtime does not know counts in UTC
    chat.app.users.setTz(chat.memberId, "Mars/Olympus");
    const utc = (await (
      await chat.admin.call("GET", "/api/directory/users/casey/days")
    ).json()) as DirectoryUserDaysResponse;
    expect(utc.days.at(-1)).toBe("2026-09-15");
    // the visit was kept as the 16th, past the UTC window
    expect(utc.usage.at(-1)).toBe(2);

    await chat.app.shutdown();
  });

  test("a request with no valid login writes no visit", async () => {
    const chat = await chatApp();
    chat.app.now.value = Date.parse("2026-09-16T10:00:00Z");
    await chat.member.call("GET", "/api/me");
    expect((await chat.member.login("casey", "pw")).status).toBe(200);
    // the login route opens the login; the visit is the next request's
    expect(visits(chat, chat.memberId)).toHaveLength(0);
    chat.app.users.setDisabled(chat.memberId, true);
    expect((await chat.member.call("GET", "/api/projects")).status).toBe(401);
    expect(visits(chat, chat.memberId)).toHaveLength(0);
    await chat.app.shutdown();
  });

  test("answers 404 to a stranger and 400 to any query", async () => {
    const chat = await chatApp();
    expect((await chat.member.login("casey", "pw")).status).toBe(200);
    const cases: [string, number][] = [
      ["/api/directory/users/nobody/days", 404],
      ["/api/directory/users/casey/days?tz=UTC", 400],
      ["/api/directory/users/casey/days?weeks=16", 400],
    ];
    for (const [path, status] of cases) {
      expect((await chat.member.call("GET", path)).status, path).toBe(status);
    }
    await chat.app.shutdown();
  });
});
