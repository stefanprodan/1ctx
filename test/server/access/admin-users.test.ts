// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import type {
  UsersResponse,
  UserUsageResponse,
} from "../../../src/shared/api/users.ts";
import { chatApp, startChat, tick } from "../../helpers/chat.ts";

async function listed(chat: Awaited<ReturnType<typeof chatApp>>) {
  const res = await chat.admin.call("GET", "/api/users");
  expect(res.status).toBe(200);
  return ((await res.json()) as UsersResponse).users;
}

test("the admin's list says each user's last visit and team projects", async () => {
  const chat = await chatApp();
  const { project } = await (
    await chat.admin.call("POST", "/api/projects", { body: { name: "ops" } })
  ).json();
  await chat.admin.call("POST", `/api/projects/${project.id}/members`, {
    body: { userId: chat.memberId },
  });
  await chat.member.call("GET", "/api/me");
  const casey = (await listed(chat)).find((u) => u.id === chat.memberId)!;
  // the personal project is not a team one
  expect(casey.projectIds).toEqual([project.id]);
  expect(casey.lastVisitDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const never = await chat.admin.call("POST", "/api/users", {
    body: {
      username: "newcomer",
      fullName: "New Comer",
      email: "newcomer@example.com",
      role: "member",
      tz: "UTC",
      password: "longenough",
    },
  });
  const created = (await never.json()).user;
  expect(created.lastVisitDay).toBeNull();
  // the list reads the latest of several days, and null for none
  chat.app.db
    .query("insert into visits (user_id, day, at) values (?, ?, ?), (?, ?, ?)")
    .run(chat.memberId, "2026-01-02", 1, chat.memberId, "2026-01-01", 0);
  const again = await listed(chat);
  expect(again.find((u) => u.id === created.id)!.lastVisitDay).toBeNull();
  expect(again.find((u) => u.id === chat.memberId)!.lastVisitDay).toBe(
    casey.lastVisitDay! > "2026-01-02" ? casey.lastVisitDay : "2026-01-02",
  );
  const res = await chat.admin.call("PATCH", `/api/users/${chat.memberId}`, {
    body: { fullName: "Casey D" },
  });
  const { user } = await res.json();
  expect(user.projectIds).toEqual([project.id]);
});

test("a user's usage counts their personal project alone", async () => {
  const chat = await chatApp();
  // a turn in a team project they are in is not theirs alone
  const { project } = await (
    await chat.admin.call("POST", "/api/projects", { body: { name: "ops" } })
  ).json();
  await chat.admin.call("POST", `/api/projects/${project.id}/members`, {
    body: { userId: chat.memberId },
  });
  const agentSends = async () => {
    const res = await chat.admin.call(
      "GET",
      `/api/agents/${chat.agentId}/usage`,
    );
    return ((await res.json()) as { sends: number }).sends;
  };
  const settled = async (sends: number) => {
    for (let i = 0; i < 50 && (await agentSends()) < sends; i++) await tick();
    expect(await agentSends()).toBe(sends);
  };
  const team = await startChat(chat, "in the team", chat.member, project.id);
  team.script.reply("done");
  await settled(1);
  const own = await chat.admin.call("GET", `/api/users/${chat.memberId}/usage`);
  expect(await own.json()).toMatchObject({ sends: 0, tokens: 0 });
  const started = await startChat(chat);
  started.script.reply("done");
  await settled(2);
  const res = await chat.admin.call("GET", `/api/users/${chat.memberId}/usage`);
  const body = (await res.json()) as UserUsageResponse;
  expect(body.sends).toBe(1);
  expect(body.tokens).toBeGreaterThan(0);
  expect(body.until - body.since).toBe(30 * 24 * 60 * 60 * 1000);
  const other = await chat.admin.call(
    "GET",
    `/api/users/${chat.adminId}/usage`,
  );
  expect(await other.json()).toMatchObject({ sends: 0, tokens: 0, cost: 0 });
});
