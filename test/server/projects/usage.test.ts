// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import type { ProjectUsageResponse } from "../../../src/shared/api/projects.ts";
import { chatApp, startChat, tick } from "../../helpers/chat.ts";

test("a team project's usage counts every turn in it, and only there", async () => {
  const chat = await chatApp();
  const { project } = await (
    await chat.admin.call("POST", "/api/projects", {
      body: { name: "ops", description: "A team project." },
    })
  ).json();
  await chat.admin.call("POST", `/api/projects/${project.id}/members`, {
    body: { userId: chat.memberId },
  });
  const usage = async () => {
    const res = await chat.admin.call(
      "GET",
      `/api/projects/${project.id}/usage`,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as ProjectUsageResponse;
  };
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
  expect(await usage()).toMatchObject({ sends: 0, tokens: 0, cost: 0 });
  // a turn in the member's personal project is not the team's
  const own = await startChat(chat);
  own.script.reply("done");
  await settled(1);
  expect((await usage()).sends).toBe(0);
  const team = await startChat(chat, "in the team", chat.member, project.id);
  team.script.reply("done");
  await settled(2);
  const body = await usage();
  expect(body.sends).toBe(1);
  expect(body.tokens).toBeGreaterThan(0);
  expect(body.until - body.since).toBe(30 * 24 * 60 * 60 * 1000);
  // a personal project is never an admin's to read
  const { projects } = await (
    await chat.member.call("GET", "/api/projects")
  ).json();
  const personal = projects.find(
    (p: { kind: string }) => p.kind === "personal",
  );
  const res = await chat.admin.call(
    "GET",
    `/api/projects/${personal.id}/usage`,
  );
  expect(res.status).toBe(404);
});
