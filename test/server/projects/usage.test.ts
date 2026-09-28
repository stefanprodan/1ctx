// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import type { SendTotalsResponse } from "../../../src/shared/api/admin.ts";
import { chatApp, startChat } from "../../helpers/chat.ts";
import { createTeam } from "../../helpers/projects.ts";
import { waitAgentSends } from "../../helpers/usage.ts";

test("a team project's usage counts every turn in it, and only there", async () => {
  const chat = await chatApp();
  const project = await createTeam(chat.admin, "ops", [chat.memberId]);
  const usage = async () => {
    // the window is [since, until): a row stamped now is not in it yet
    chat.app.now.value += 1;
    const res = await chat.admin.call(
      "GET",
      `/api/projects/${project.id}/usage`,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as SendTotalsResponse;
  };
  expect(await usage()).toMatchObject({ sends: 0, tokens: 0, cost: 0 });
  // a turn in the member's personal project is not the team's
  const own = await startChat(chat);
  own.script.reply("done");
  await waitAgentSends(chat, 1);
  expect((await usage()).sends).toBe(0);
  const team = await startChat(chat, "in the team", chat.member, project.id);
  team.script.reply("done");
  await waitAgentSends(chat, 2);
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
