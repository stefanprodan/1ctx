// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { UsageStore } from "../../../src/server/usage/index.ts";
import type { AccessBoardResponse } from "../../../src/shared/api/access.ts";
import { chatApp, startChat, tick } from "../../helpers/chat.ts";
import { watcher } from "../../helpers/socket.ts";

type Chat = Awaited<ReturnType<typeof chatApp>>;

async function board(chat: Chat, tz = "UTC") {
  const res = await chat.admin.call(
    "GET",
    `/api/admin/access?tz=${encodeURIComponent(tz)}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as AccessBoardResponse;
}

const visit = (chat: Chat, userId: string, day: string) =>
  chat.app.db
    .query("insert or ignore into visits (user_id, day, at) values (?, ?, ?)")
    .run(userId, day, 0);

const shift = (day: string, by: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000)
    .toISOString()
    .slice(0, 10);

test("a visit counts on its user's own date, in the reader's 30 days", async () => {
  const chat = await chatApp();
  chat.app.db.query("delete from visits").run();
  const first = await board(chat);
  expect(first.days).toHaveLength(30);
  expect(first.signedIn).toBe(0);
  const today = first.days.at(-1)!.day;
  visit(chat, chat.memberId, shift(today, -10));
  // the first day of the window counts, the day before it never
  visit(chat, chat.memberId, shift(today, -29));
  visit(chat, chat.adminId, shift(today, -30));
  // a user already on the reader's tomorrow counts today
  visit(chat, chat.adminId, shift(today, 1));
  const next = await board(chat);
  expect(next.days.at(-11)!.signedIn).toBe(1);
  expect(next.days[0]!.signedIn).toBe(1);
  expect(next.days.at(-1)!.signedIn).toBe(1);
  expect(next.signedIn).toBe(2);
  expect(next.days.reduce((sum, d) => sum + d.signedIn, 0)).toBe(3);
});

test("the days are the reader's, however far east or west", async () => {
  const chat = await chatApp();
  const east = await board(chat, "Etc/GMT-14");
  const west = await board(chat, "Etc/GMT+12");
  // 26 hours apart: the east's today is the west's tomorrow or later
  expect(east.days.at(-1)!.day > west.days.at(-1)!.day).toBe(true);
  expect(east.days).toHaveLength(30);
  expect(west.days).toHaveLength(30);
});

test("the board names the team projects with a turn in the window", async () => {
  const chat = await chatApp();
  const made = async (name: string) =>
    (
      await (
        await chat.admin.call("POST", "/api/projects", {
          body: { name, description: "A team project." },
        })
      ).json()
    ).project.id as string;
  const busy = await made("busy");
  const quiet = await made("quiet");
  await chat.admin.call("POST", `/api/projects/${busy}/members`, {
    body: { userId: chat.memberId },
  });
  const started = await startChat(chat, "hi", chat.member, busy);
  started.script.reply("done");
  for (
    let i = 0;
    i < 50 && !(await board(chat)).activeProjectIds.includes(busy);
    i++
  ) {
    await tick();
  }
  const ids = (await board(chat)).activeProjectIds;
  expect(ids).toContain(busy);
  expect(ids).not.toContain(quiet);
  // a personal project is never named, however busy
  const own = await startChat(chat);
  own.script.reply("done");
  await tick();
  expect((await board(chat)).activeProjectIds).toEqual([busy]);
});

test("a project is active from the window's first instant, not after it", async () => {
  const chat = await chatApp();
  const usage = new UsageStore(chat.app.db);
  const row = chat.app.db.query(
    `insert into usage (id, send_id, session_id, project_id, user_id,
       agent_id, provider_id, model, round, seq, prompt_tokens,
       completion_tokens, created_at)
     values (?, ?, 's', ?, 'u', 'a', 'p', 'm', 0, 0, 1, 1, ?)`,
  );
  row.run("r1", "x1", "edge", 1_000);
  row.run("r2", "x2", "old", 999);
  row.run("r3", "x3", "late", 2_000);
  expect(
    usage.activeProjects(["edge", "old", "late", "none"], 1_000, 2_000),
  ).toEqual(["edge"]);
});

test("the board takes the zone and nothing else", async () => {
  const chat = await chatApp();
  for (const query of [
    "",
    "?tz=Nowhere/City",
    "?tz=UTC&tz=UTC",
    "?tz=UTC&x=1",
  ]) {
    const res = await chat.admin.call("GET", `/api/admin/access${query}`);
    expect(res.status).toBe(400);
  }
});

test("recent puts the online first, then the latest, and needs a visit", async () => {
  const chat = await chatApp();
  chat.app.db.query("delete from visits").run();
  chat.app.db.query("update logins set last_seen_at = 0").run();
  const now = chat.app.now.value;
  const add = (userId: string, at: number) =>
    chat.app.db
      .query("insert into visits (user_id, day, at) values (?, ?, ?)")
      .run(userId, "2026-01-01", at);
  // no visit: the board calls the admin inactive, so never recent
  add(chat.memberId, now - 5);
  const first = await board(chat);
  expect(first.recent).toEqual([
    { userId: chat.memberId, at: now - 5, online: false },
  ]);
  add(chat.adminId, now - 3);
  const offline = await board(chat);
  expect(offline.recent.map((r) => r.userId)).toEqual([
    chat.adminId,
    chat.memberId,
  ]);
  // a login touched later than the visit is the newer time
  chat.app.db
    .query("update logins set last_seen_at = ? where user_id = ?")
    .run(now - 1, chat.memberId);
  expect((await board(chat)).recent[0]).toEqual({
    userId: chat.memberId,
    at: now - 1,
    online: false,
  });
  // a tab open puts the admin first, whatever the times; two online
  // are ordered by time
  const admin = await watcher(chat, chat.admin);
  expect((await board(chat)).recent[0]).toEqual({
    userId: chat.adminId,
    at: now - 3,
    online: true,
  });
  const member = await watcher(chat, chat.member);
  expect((await board(chat)).recent.map((r) => r.userId)).toEqual([
    chat.memberId,
    chat.adminId,
  ]);
  chat.app.socket.close(admin);
  chat.app.socket.close(member);
  expect((await board(chat)).recent[0]!.online).toBe(false);
});

test("recent leaves out the disabled and those not seen in the window", async () => {
  const chat = await chatApp();
  chat.app.now.value = Date.parse("2026-09-28T12:00:00Z");
  const now = chat.app.now.value;
  chat.app.db.query("delete from visits").run();
  // a clock past the epoch's first month, the logins still alive
  chat.app.db
    .query("update logins set last_seen_at = ?, expires_at = ?")
    .run(now - 31 * 86_400_000, now + 86_400_000);
  const visit = (day: string, at: number) =>
    chat.app.db
      .query(
        "insert or replace into visits (user_id, day, at) values (?, ?, ?)",
      )
      .run(chat.memberId, day, at);
  // the admin reading the board is seen today
  visit("2026-08-28", now - 31 * 86_400_000);
  const stale = await board(chat);
  expect(stale.recent.map((r) => r.userId)).toEqual([chat.adminId]);
  visit("2026-09-28", now - 5);
  expect((await board(chat)).recent.map((r) => r.userId)).toContain(
    chat.memberId,
  );
  chat.app.db
    .query("update users set disabled = 1 where id = ?")
    .run(chat.memberId);
  expect((await board(chat)).recent.map((r) => r.userId)).toEqual([
    chat.adminId,
  ]);
});
