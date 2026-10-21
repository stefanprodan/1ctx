// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, spyOn, test } from "bun:test";
import type { Principal } from "../../../src/server/lib/http.ts";
import { chatFor } from "../../../src/server/runner/chat-guard.ts";
import type {
  ChannelPostResponse,
  FeedRow,
  SessionsResponse,
} from "../../../src/shared/api/sessions.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import { hashPassword } from "../../helpers/app.ts";
import { chatApp, idle } from "../../helpers/chat.ts";
import { createTeam } from "../../helpers/projects.ts";
import { files, stage } from "../runner/uploads-helpers.ts";

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
  uploads: string[] = [],
) {
  return call("POST", `/api/sessions/${id}/messages`, {
    body: { message, ...(uploads.length === 0 ? {} : { uploads }) },
  });
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
    const parent = await post(chat.member.call, channelId, "parent");
    const parentMessage = ((await parent.json()) as ChannelPostResponse)
      .messages[0]!;
    chat.app.db
      .query(
        `insert into sessions
          (id, project_id, owner_id, agent_id, origin, title, status,
           created_at, last_activity_at, parent_session_id, parent_message_id)
         values ('channelchild', ?, ?, ?, 'channel', 'child', 'done', 1, 1,
           ?, ?)`,
      )
      .run(
        project.id,
        chat.memberId,
        chat.agentId,
        channelId,
        parentMessage.id,
      );
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
    expect(
      chat.app.db
        .query("select title, revision from sessions where id = 'channelchild'")
        .get(),
    ).toEqual({ title: "child", revision: 0 });
  });

  test("writes a post at once without a model send or usage", async () => {
    const { chat, channelId } = await setup();
    const response = await post(chat.member.call, channelId, "Ship the fix");
    expect(response.status).toBe(201);
    const shown = (await response.json()) as ChannelPostResponse;
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
    const next = await post(chat.member.call, channelId, "Only the new post");
    expect(next.status).toBe(201);
    const added = (await next.json()) as ChannelPostResponse;
    expect(added.messages.map((row) => row.content)).toEqual([
      "Only the new post",
    ]);
    expect("forkedFrom" in added).toBe(false);
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

  test("a post advances activity without setting the channel status", async () => {
    const { chat, channelId } = await setup();
    chat.app.db
      .query(
        "update sessions set status = 'running', last_activity_at = 1, revision = 7 where id = ?",
      )
      .run(channelId);
    chat.app.now.value = 20;
    const response = await post(chat.member.call, channelId, "while running");
    expect(response.status).toBe(201);
    expect((await response.json()).session).toMatchObject({
      status: "running",
      lastActivityAt: 20,
      revision: 8,
    });
  });

  test("claims staged uploads into a post", async () => {
    const { chat, project, channelId } = await setup();
    const upload = await stage(
      chat,
      "note.txt",
      "attached text",
      chat.member,
      project.id,
    );
    const response = await post(chat.member.call, channelId, "read this", [
      upload.id,
    ]);
    expect(response.status).toBe(201);
    const added = (await response.json()) as ChannelPostResponse;
    expect(added.messages[0]?.uploads).toEqual([
      {
        name: "note.txt",
        archive: false,
        files: 1,
        bytes: 13,
        saved: ["note.txt"],
      },
    ]);
    expect(files(chat, channelId)).toEqual([
      { name: "note.txt", text: "attached text" },
    ]);
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

  test("treats visible users as posts and an agent wins a shared name", async () => {
    const { chat, project, channelId } = await setup();
    expect(
      (await post(chat.member.call, channelId, "@casey, look")).status,
    ).toBe(201);
    const admin = chat.app.createUser({
      username: "opsadmin",
      fullName: "Ops Admin",
      email: "opsadmin@example.com",
      role: "admin",
      passwordHash: await hashPassword("pw"),
      mustChangePassword: false,
      now: chat.app.now.value,
    });
    expect(chat.app.projects.isMember(project.id, admin.id)).toBe(false);
    expect(
      (await post(chat.member.call, channelId, "@opsadmin check")).status,
    ).toBe(201);
    await chat.makeAgent({
      name: "casey",
      model: "deepseek/deepseek-v4.1-flash",
    });
    const collision = await post(chat.member.call, channelId, "@casey, look");
    expect(collision.status).toBe(201);
    const summon = await post(chat.member.call, channelId, "@coder check");
    expect(summon.status).toBe(201);
    (await chat.scripted.reached(1)).reply("casey");
    (await chat.scripted.reached(2)).reply("coder");
    await idle(chat.app);
    const unknown = await post(chat.member.call, channelId, "@missing check");
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "no agent named missing" });
  });

  test("cannot be forked, renamed, archived, deleted, regenerated or compacted", async () => {
    const { chat, channelId } = await setup();
    const cases: [string, string, unknown, string][] = [
      [
        "POST",
        `/api/sessions/${channelId}/fork`,
        { messageId: "aaaaaaaaaaaa", agentId: chat.agentId },
        "forked",
      ],
      ["PATCH", `/api/sessions/${channelId}`, { title: "other" }, "renamed"],
      ["POST", `/api/sessions/${channelId}/archive`, undefined, "archived"],
      ["DELETE", `/api/sessions/${channelId}`, undefined, "deleted"],
      ["POST", `/api/sessions/${channelId}/regenerate`, {}, "regenerated"],
      ["POST", `/api/sessions/${channelId}/compact`, undefined, "compacted"],
      ["POST", `/api/sessions/${channelId}/stop`, undefined, "stopped"],
    ];
    for (const [method, path, body, verb] of cases) {
      const response = await chat.member.call(method, path, { body });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: `a channel cannot be ${verb}`,
      });
    }
  });

  test("the chat guard names each channel operation", async () => {
    const { chat, channelId } = await setup();
    const channel = chat.app.sessions.byId(channelId)!;
    const principal = {} as Principal;
    for (const [verb, word] of [
      ["continue", "continued"],
      ["regenerate", "regenerated"],
      ["compact", "compacted"],
    ] as const) {
      let message = "";
      try {
        chatFor({ visible: () => channel }, principal, channelId, verb);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe(`a channel cannot be ${word}`);
    }
  });

  test("a search unpins the channel and returns it only on a match", async () => {
    const { chat, project, channelId } = await setup();
    const matching = (await (
      await chat.member.call(
        "GET",
        `/api/sessions?project=${project.id}&q=plat`,
      )
    ).json()) as SessionsResponse;
    expect(matching.rows.map((row) => row.session.id)).toEqual([channelId]);
    expect(matching.rows[0]?.pinned).toBeUndefined();
    const missing = (await (
      await chat.member.call(
        "GET",
        `/api/sessions?project=${project.id}&q=missing`,
      )
    ).json()) as SessionsResponse;
    expect(missing.rows).toEqual([]);
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

  test("pages a project feed with the pinned channel exactly once", async () => {
    const { chat, project, channelId } = await setup();
    const insert = chat.app.db.query(
      `insert into sessions
        (id, project_id, owner_id, agent_id, origin, title, status,
         created_at, last_activity_at)
       values (?, ?, ?, ?, 'chat', ?, 'done', ?, ?)`,
    );
    for (let i = 0; i < 60; i++) {
      insert.run(
        `chat${i.toString().padStart(8, "0")}`,
        project.id,
        chat.memberId,
        chat.agentId,
        `chat ${i}`,
        i,
        i,
      );
    }
    const collect = async (origin: "" | "&origin=chat") => {
      const pages: FeedRow[][] = [];
      let before: string | null = null;
      for (let i = 0; i < 3; i++) {
        const cursor = before === null ? "" : `&before=${before}`;
        const response = await chat.member.call(
          "GET",
          `/api/sessions?project=${project.id}${origin}${cursor}`,
        );
        expect(response.status).toBe(200);
        const page = (await response.json()) as SessionsResponse;
        pages.push(page.rows);
        if (page.next === null) return pages;
        before = page.next;
      }
      throw new Error("project feed did not end");
    };
    for (const origin of ["", "&origin=chat"] as const) {
      const pages = await collect(origin);
      expect(pages.map((page) => page.length)).toEqual([50, 11]);
      const rows = pages.flat();
      expect(new Set(rows.map((row) => row.session.id)).size).toBe(61);
      expect(rows.filter((row) => row.session.id === channelId)).toHaveLength(
        1,
      );
      expect(pages[0]?.[0]).toMatchObject({
        pinned: true,
        session: { id: channelId },
      });
      expect(pages[1]?.some((row) => row.pinned)).toBe(false);
    }
  });

  test("every channel page statement seeks messages and sends", async () => {
    const { chat, channelId } = await setup();
    for (let i = 1; i <= 3; i++) {
      expect(
        (await post(chat.member.call, channelId, `post ${i}`)).status,
      ).toBe(201);
    }
    const query = spyOn(chat.app.db, "query");
    let sqls: string[];
    try {
      chat.app.sessions.channelPage(channelId, { before: null, around: null });
      chat.app.sessions.channelPage(channelId, { before: null, around: 2 });
      sqls = [
        ...new Set(
          query.mock.calls
            .map(([sql]) => sql)
            .filter(
              (sql) =>
                sql.includes("messages") &&
                sql.includes("sends") &&
                (sql.includes("messages.kind = 'user'") ||
                  sql.includes("select post.send_id")),
            ),
        ),
      ];
    } finally {
      query.mockRestore();
    }
    expect(sqls).toHaveLength(5);
    for (const sql of sqls) {
      const args = sql.includes("json_each")
        ? [channelId, "[]"]
        : sql.includes("? is null")
          ? [channelId, null, null, 51]
          : sql.includes("limit ?")
            ? [channelId, 2, 26]
            : [channelId, 2];
      const plan = chat.app.db
        .query<{ detail: string }, (string | number | null)[]>(
          `explain query plan ${sql}`,
        )
        .all(...args)
        .map((row) => row.detail);
      expect(
        plan.some((line) => /^SCAN (?:TABLE )?(sends|messages)\b/.test(line)),
      ).toBe(false);
      if (sql.includes("select post.send_id")) {
        expect(plan).toContain(
          "SEARCH sends USING INDEX sends_session (session_id=?)",
        );
        expect(plan).toContain(
          "SEARCH messages USING INDEX messages_send (send_id=?)",
        );
      }
    }
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
