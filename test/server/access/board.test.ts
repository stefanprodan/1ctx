// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { UsageStore } from "../../../src/server/usage/index.ts";
import type { AccessBoardResponse } from "../../../src/shared/api/access.ts";
import { chatApp, startChat, tick } from "../../helpers/chat.ts";

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
