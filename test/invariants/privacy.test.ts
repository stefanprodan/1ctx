// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A personal project's chats are its owner's alone, an admin included:
// on every route, and on the socket.

import { describe, expect, test } from "bun:test";
import type { Conn } from "../../src/server/web/socket.ts";
import { chatApp, startChat, tick } from "../helpers/chat.ts";

function conn(chat: Awaited<ReturnType<typeof chatApp>>, admin: boolean) {
  const frames: { type: string }[] = [];
  const c: Conn & { frames: typeof frames } = {
    frames,
    data: {
      principal: {
        userId: admin ? chat.adminId : chat.memberId,
        username: admin ? "admin" : "oana",
        fullName: admin ? "Administrator" : "Oana Pellea",
        role: admin ? "admin" : "member",
        mustChangePassword: false,
        loginId: admin ? "la" : "lm",
      },
      projects: new Set(
        chat.app.projects
          .memberProjectIds(admin ? chat.adminId : chat.memberId)
          .concat(admin ? chat.app.projects.teamProjectIds() : []),
      ),
      watching: null,
    },
    send(text) {
      frames.push(JSON.parse(text));
      return text.length;
    },
    close() {},
  };
  return c;
}

describe("privacy", () => {
  test("an admin never sees a member's personal chat, on any route", async () => {
    const chat = await chatApp();
    const { script, sessionId } = await startChat(chat);
    const admin = chat.admin;
    expect((await admin.call("GET", `/api/sessions/${sessionId}`)).status).toBe(
      404,
    );
    expect(
      (
        await admin.call("POST", `/api/sessions/${sessionId}/messages`, {
          body: { message: "hi" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await admin.call("POST", `/api/sessions/${sessionId}/stop`)).status,
    ).toBe(404);
    expect(
      (
        await admin.call("PATCH", `/api/sessions/${sessionId}`, {
          body: { title: "renamed" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await admin.call("DELETE", `/api/sessions/${sessionId}`)).status,
    ).toBe(404);
    expect(
      (await admin.call("GET", `/api/sessions?project=${chat.projectId}`))
        .status,
    ).toBe(404);
    const { rows } = await (await admin.call("GET", "/api/sessions")).json();
    expect(rows).toEqual([]);
    expect(
      (await admin.call("GET", `/api/projects/${chat.projectId}/agents`))
        .status,
    ).toBe(404);
    script.reply("ok");
    await tick();
  });

  test("the socket delivers a personal chat to its owner and to nobody else", async () => {
    const chat = await chatApp();
    const mine = conn(chat, false);
    const theirs = conn(chat, true);
    chat.app.socket.open(mine);
    chat.app.socket.open(theirs);
    const { script, sessionId } = await startChat(chat);
    chat.app.socket.message(
      theirs,
      JSON.stringify({ type: "watch", sessionId }),
    );
    chat.app.socket.message(mine, JSON.stringify({ type: "watch", sessionId }));
    script.content("secret");
    script.reply(" more");
    await tick();
    await tick();
    const kinds = (c: typeof mine) => c.frames.map((f) => f.type);
    expect(kinds(mine)).toEqual([
      "hello",
      "session",
      "watched",
      "delta",
      "delta",
      "session",
    ]);
    expect(kinds(theirs)).toEqual(["hello"]);
    expect(JSON.stringify(theirs.frames)).not.toContain("secret");
    chat.app.socket.close(mine);
    chat.app.socket.close(theirs);
  });

  test("a work envelope stays project-scoped: the owner sees it, an admin does not", async () => {
    const chat = await chatApp();
    const mine = conn(chat, false);
    const theirs = conn(chat, true);
    chat.app.socket.open(mine);
    chat.app.socket.open(theirs);
    const { script, sessionId } = await startChat(chat, "when");
    // the first call delta marks the reply work and publishes a durable
    // envelope; it reaches the owner's connection and no one else's
    script.toolCall({
      id: "c1",
      name: "get_current_time",
      arguments: '{"timezone":"UTC"}',
    });
    await tick();
    const durable = (c: typeof mine) =>
      c.frames.filter((f) => f.type === "session");
    expect(durable(mine).length).toBeGreaterThanOrEqual(1);
    expect(durable(theirs)).toEqual([]);
    expect(JSON.stringify(theirs.frames)).not.toContain("get_current_time");
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await tick();
    await tick();
    chat.app.socket.close(mine);
    chat.app.socket.close(theirs);
  });

  test("the visible set is the memberships, plus every team project for an admin", async () => {
    const chat = await chatApp();
    expect(chat.app.projects.memberProjectIds(chat.memberId)).toEqual([
      chat.projectId,
    ]);
    chat.app.db
      .query(
        "insert into projects (id, kind, name, owner_id, created_at) values ('t1', 'team', 'team', ?, 0)",
      )
      .run(chat.memberId);
    chat.app.db
      .query(
        "insert into memberships (project_id, user_id, created_at) values ('t1', ?, 0)",
      )
      .run(chat.memberId);
    const { rows: adminSees } = await (
      await chat.admin.call("GET", "/api/sessions?project=t1")
    ).json();
    expect(adminSees).toEqual([]);
    const team = await startChat(chat, "team chat", chat.member, "t1");
    team.script.reply("ok");
    await tick();
    await tick();
    const { rows } = await (
      await chat.admin.call("GET", "/api/sessions")
    ).json();
    expect(
      rows.map((row: { session: { id: string } }) => row.session.id),
    ).toEqual([team.sessionId]);
  });
});
