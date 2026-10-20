// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type {
  FeedRow,
  SessionsResponse,
} from "../../../src/shared/api/sessions.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import { hashPassword } from "../../helpers/app.ts";
import { chatApp } from "../../helpers/chat.ts";
import { createTeam } from "../../helpers/projects.ts";

async function setup() {
  const chat = await chatApp();
  const project = await createTeam(chat.admin, "platform", [chat.memberId]);
  const channel = chat.app.db
    .query<{ id: string }, [string]>(
      "select id from sessions where project_id = ? and origin = 'channel'",
    )
    .get(project.id)!;
  return { chat, project, channelId: channel.id };
}

async function detail(
  call: Awaited<ReturnType<typeof setup>>["chat"]["member"]["call"],
  id: string,
  query = "",
): Promise<{ response: Response; body: SessionDetail | { error: string } }> {
  const response = await call("GET", `/api/sessions/${id}${query}`);
  return { response, body: await response.json() };
}

async function post(
  call: Awaited<ReturnType<typeof setup>>["chat"]["member"]["call"],
  id: string,
  message: string,
) {
  return call("POST", `/api/sessions/${id}/messages`, { body: { message } });
}

describe("the project channel", () => {
  test("is made only for a team project and follows its name", async () => {
    const { chat, project, channelId } = await setup();
    const personal = chat.app.projects.personal(chat.memberId)!;
    expect(
      chat.app.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from sessions where project_id = ? and origin = 'channel'",
        )
        .get(personal.id),
    ).toEqual({ n: 0 });
    const shown = await detail(chat.member.call, channelId);
    expect(shown.response.status).toBe(200);
    expect((shown.body as SessionDetail).session).toMatchObject({
      projectId: project.id,
      title: "platform",
      origin: "channel",
      ownerId: null,
      agentId: null,
      droppedSeq: null,
      status: "done",
    });
    const renamed = await chat.admin.call(
      "PATCH",
      `/api/projects/${project.id}`,
      {
        body: { name: "runtime" },
      },
    );
    expect(renamed.status).toBe(200);
    expect((await detail(chat.member.call, channelId)).body).toMatchObject({
      session: { title: "runtime" },
    });
  });

  test("writes a post at once without a model send or usage", async () => {
    const { chat, channelId } = await setup();
    const response = await post(chat.member.call, channelId, "Ship the fix");
    expect(response.status).toBe(201);
    const shown = (await response.json()) as SessionDetail;
    expect(shown.messages).toHaveLength(1);
    expect(shown.messages[0]).toMatchObject({
      kind: "user",
      content: "Ship the fix",
      userId: chat.memberId,
      status: "done",
      round: 1,
    });
    expect(shown.send).toMatchObject({
      kind: "post",
      agentId: null,
      providerId: null,
      model: null,
      status: "done",
      rounds: 1,
      toolCalls: 0,
      tokens: 0,
    });
    expect(
      chat.app.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from usage where session_id = ?",
        )
        .get(channelId),
    ).toEqual({ n: 0 });
    expect(chat.scripted.chats()).toBe(0);
    const monitor = await chat.admin.call("GET", "/api/admin/overview?tz=UTC");
    expect(monitor.status).toBe(200);
    expect((await monitor.json()).totals).toMatchObject({
      turns: 0,
      turnsFailed: 0,
      runs: 0,
    });
  });

  test("lets members and admins post, hides it from everyone else", async () => {
    const { chat, channelId } = await setup();
    expect((await post(chat.member.call, channelId, "member")).status).toBe(
      201,
    );
    expect((await post(chat.admin.call, channelId, "admin")).status).toBe(201);
    const outsider = chat.app.createUser({
      username: "outsider",
      fullName: "Out Sider",
      email: "outsider@example.com",
      role: "member",
      passwordHash: await hashPassword("pw"),
      mustChangePassword: false,
      now: chat.app.now.value,
    });
    expect(outsider.id).not.toBe("");
    const client = chat.app.client();
    await client.login("outsider", "pw");
    expect(
      (await client.call("GET", `/api/sessions/${channelId}`)).status,
    ).toBe(404);
    expect((await post(client.call, channelId, "hidden")).status).toBe(404);
  });

  test("treats a member first word as a post and refuses summons for K2", async () => {
    const { chat, channelId } = await setup();
    expect(
      (await post(chat.member.call, channelId, "@casey, look")).status,
    ).toBe(201);
    await chat.makeAgent({
      name: "casey",
      model: "deepseek/deepseek-v4.1-flash",
    });
    const collision = await post(chat.member.call, channelId, "@casey, look");
    expect(collision.status).toBe(409);
    const summon = await post(chat.member.call, channelId, "@coder check");
    expect(summon.status).toBe(409);
    expect(await summon.json()).toEqual({
      error: "summons in a channel are not built yet",
    });
    const unknown = await post(chat.member.call, channelId, "@missing check");
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "no agent named missing" });
  });

  test("cannot be forked, renamed, archived, deleted, regenerated or compacted", async () => {
    const { chat, channelId } = await setup();
    const cases: [string, string, unknown?][] = [
      [
        "POST",
        `/api/sessions/${channelId}/fork`,
        { messageId: "aaaaaaaaaaaa", agentId: chat.agentId },
      ],
      ["PATCH", `/api/sessions/${channelId}`, { title: "other" }],
      ["POST", `/api/sessions/${channelId}/archive`],
      ["DELETE", `/api/sessions/${channelId}`],
      ["POST", `/api/sessions/${channelId}/regenerate`, {}],
      ["POST", `/api/sessions/${channelId}/compact`],
    ];
    for (const [method, path, body] of cases) {
      const response = await chat.member.call(method, path, { body });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain("a channel cannot be");
    }
  });

  test("pins the channel in a project feed but activity-sorts it on Home", async () => {
    const { chat, project, channelId } = await setup();
    const projectFeed = (await (
      await chat.member.call("GET", `/api/sessions?project=${project.id}`)
    ).json()) as SessionsResponse;
    expect(projectFeed.rows[0]?.session.id).toBe(channelId);
    expect(projectFeed.rows[0]?.pinned).toBe(true);
    const chats = (await (
      await chat.member.call(
        "GET",
        `/api/sessions?project=${project.id}&origin=chat`,
      )
    ).json()) as SessionsResponse;
    expect(chats.rows[0]?.session.id).toBe(channelId);
    expect(chats.rows[0]?.pinned).toBe(true);
    expect(
      (
        (await (
          await chat.member.call(
            "GET",
            `/api/sessions?project=${project.id}&origin=automation`,
          )
        ).json()) as SessionsResponse
      ).rows,
    ).toEqual([]);
    const home = (await (
      await chat.member.call("GET", "/api/sessions")
    ).json()) as SessionsResponse;
    expect(
      home.rows.find((row: FeedRow) => row.session.id === channelId)?.pinned,
    ).toBeUndefined();
  });

  test("pages newest whole posts and reads a window around an old seq", async () => {
    const { chat, channelId } = await setup();
    for (let i = 1; i <= 55; i++) {
      const response = await post(chat.member.call, channelId, `post ${i}`);
      expect(response.status).toBe(201);
    }
    const latest = (await detail(chat.member.call, channelId))
      .body as SessionDetail;
    expect(latest.messages).toHaveLength(50);
    expect(latest.messages[0]?.content).toBe("post 6");
    expect(latest.messages.at(-1)?.content).toBe("post 55");
    expect(latest.page?.before).toBe(6);
    const older = (
      await detail(
        chat.member.call,
        channelId,
        `?before=${latest.page?.before}`,
      )
    ).body as SessionDetail;
    expect(older.messages.map((row) => row.content)).toEqual([
      "post 1",
      "post 2",
      "post 3",
      "post 4",
      "post 5",
    ]);
    expect(older.page?.before).toBeNull();
    const window = (await detail(chat.member.call, channelId, "?around=3"))
      .body as SessionDetail;
    expect(window.messages.some((row) => row.seq === 3)).toBe(true);
    expect(window.page?.after).not.toBeNull();
  });
});
