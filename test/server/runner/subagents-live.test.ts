// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A subagent's rows reach its root's watchers alone, a watch mid-turn
// gets them so far, and the child route reads them under the root.

import { describe, expect, test } from "bun:test";
import type { ChildWork } from "../../../src/shared/contracts/session.ts";
import { hashPassword } from "../../helpers/app.ts";
import { type ChatApp, startChat, waitScript } from "../../helpers/chat.ts";
import { createTeam } from "../../helpers/projects.ts";
import { frames, watch, watcher } from "../../helpers/socket.ts";
import {
  childrenOf,
  delegateCall,
  delegateRows,
  settled,
  subagentApp,
} from "../../helpers/subagents.ts";

const clockCall = (id: string) => ({
  id,
  name: "datetime",
  arguments: JSON.stringify({ timezone: "UTC" }),
});

async function outsider(chat: ChatApp) {
  chat.app.createUser({
    username: "erin",
    fullName: "Erin Doe",
    email: "erin@example.com",
    role: "member",
    passwordHash: await hashPassword("pw"),
    mustChangePassword: false,
    now: chat.app.now.value,
  });
  const client = chat.app.client();
  await client.login("erin", "pw");
  return client;
}

// a team chat of the member's, the admin in the project too, whose
// agent delegates one task that calls the clock, then answers
async function delegated(chat: ChatApp) {
  const team = await createTeam(chat.admin, "ops", [chat.memberId]);
  const started = await startChat(chat, "survey", chat.member, team.id);
  return { team, ...started };
}

describe("a subagent's live rows", () => {
  test.serial(
    "reach the root's watchers alone, as rows, never as text",
    async () => {
      const chat = await subagentApp();
      try {
        const watching = await watcher(chat);
        const member = await watcher(chat, chat.admin);
        const erin = await outsider(chat);
        const other = await watcher(chat, erin);
        const { script, sessionId } = await delegated(chat);
        watch(chat, watching, sessionId);
        // the outsider's watch is refused and the admin watches nothing
        watch(chat, other, sessionId);
        script.toolRound([delegateCall("d1", "Read the clock.")]);
        script.end();
        const child = await waitScript(chat.scripted, 2);
        child.toolRound([clockCall("c1")], { prompt: 40, completion: 4 });
        child.end();
        const childNext = await waitScript(chat.scripted, 3);
        childNext.content("It is noon.");
        childNext.finish();
        childNext.usage({ prompt: 60, completion: 6 });
        childNext.end();
        const parent = await waitScript(chat.scripted, 4);
        parent.reply("noon");
        await settled(chat, sessionId);

        const [row] = delegateRows(chat, sessionId);
        const [childId] = childrenOf(chat, sessionId);
        const got = frames(watching, "child");
        expect(got.length).toBeGreaterThan(2);
        for (const frame of got) {
          expect(frame).toMatchObject({ sessionId, messageId: row!.id });
          expect(frame.child.sessionId).toBe(childId!);
        }
        // the first frame is the task and the first reply; a frame
        // carries only the rows its commit changed
        expect(got[0]!.child.rows.map((r) => r.kind)).toEqual([
          "user",
          "reply",
        ]);
        expect(got[0]!.child.status).toBe("running");
        const last = got.at(-1)!;
        // its context is its last round's tokens, never the sum of both
        expect(last.child).toMatchObject({ status: "done", tokens: 66 });
        const all = got.flatMap((frame) => frame.child.rows);
        const tool = all.findLast((r) => r.kind === "tool")!;
        expect(tool).toMatchObject({ toolName: "datetime", status: "done" });
        // a result stays behind, as on every row on the wire
        expect(tool.content).toBe("");
        expect(
          all.some((r) => r.slot === "answer" && r.content === "It is noon."),
        ).toBe(true);
        // the child streams to nobody, and no envelope names it
        const childRows = new Set(all.map((r) => r.id));
        for (const conn of [watching, member, other]) {
          expect(
            conn.frames.some(
              (frame) =>
                (frame.type === "delta" || frame.type === "html") &&
                (frame.sessionId === childId || childRows.has(frame.messageId)),
            ),
          ).toBe(false);
          expect(
            frames(conn, "session").some(
              (frame) => frame.session.id === childId,
            ),
          ).toBe(false);
        }
        // a member not watching and a user of another project hear none
        expect(frames(member, "session").length).toBeGreaterThan(0);
        expect(frames(member, "child")).toEqual([]);
        expect(frames(other, "child")).toEqual([]);
        expect(frames(other, "watched")).toEqual([]);
      } finally {
        await chat.app.shutdown();
      }
    },
  );

  test.serial(
    "a watch mid-turn gets the running child's rows so far",
    async () => {
      const chat = await subagentApp();
      try {
        const { script, sessionId } = await delegated(chat);
        script.toolRound([delegateCall("d1", "Read the clock.")]);
        script.end();
        const child = await waitScript(chat.scripted, 2);
        child.toolRound([clockCall("c1")]);
        child.end();
        const childNext = await waitScript(chat.scripted, 3);

        const late = await watcher(chat);
        watch(chat, late, sessionId);
        const [answer] = frames(late, "watched");
        const [row] = delegateRows(chat, sessionId);
        expect(answer!.children).toHaveLength(1);
        const { messageId, child: work } = answer!.children![0]!;
        expect(messageId).toBe(row!.id);
        expect(work.status).toBe("running");
        expect(work.rows.map((r) => [r.kind, r.status])).toEqual([
          ["user", "done"],
          ["reply", "done"],
          ["tool", "done"],
          ["reply", "streaming"],
        ]);

        childNext.reply("noon");
        const parent = await waitScript(chat.scripted, 4);
        parent.reply("noon");
        await settled(chat, sessionId);
        // nothing runs: a watch after the turn carries no children
        const after = await watcher(chat);
        watch(chat, after, sessionId);
        expect(frames(after, "watched")[0]!.children).toBeUndefined();
      } finally {
        await chat.app.shutdown();
      }
    },
  );
});

describe("the child route", () => {
  test("reads a child under its root's access, and nothing else does", async () => {
    const chat = await subagentApp();
    try {
      const { script, sessionId } = await delegated(chat);
      script.toolRound([delegateCall("d1", "Read the clock.")]);
      script.end();
      const child = await waitScript(chat.scripted, 2);
      child.toolRound([clockCall("c1")]);
      child.end();
      (await waitScript(chat.scripted, 3)).reply("noon");
      (await waitScript(chat.scripted, 4)).reply("noon");
      await settled(chat, sessionId);

      const [row] = delegateRows(chat, sessionId);
      const [childId] = childrenOf(chat, sessionId);
      const path = (id: string, messageId: string) =>
        `/api/sessions/${id}/messages/${messageId}/child`;
      const read = await chat.member.call("GET", path(sessionId, row!.id));
      expect(read.status).toBe(200);
      const body = (await read.json()) as ChildWork;
      expect(body).toMatchObject({ sessionId: childId, status: "done" });
      expect(body.tokens).toBeGreaterThan(0);
      expect(body.rows.map((r) => r.kind)).toEqual([
        "user",
        "reply",
        "tool",
        "reply",
      ]);
      const tool = body.rows[2]!;
      expect(tool.content).toBe("");
      // a project member who never watched reads it too
      expect(
        (await chat.admin.call("GET", path(sessionId, row!.id))).status,
      ).toBe(200);
      const erin = await outsider(chat);
      expect((await erin.call("GET", path(sessionId, row!.id))).status).toBe(
        404,
      );
      // only the root's own delegate row, never the child's own id or rows
      const user = chat.app.sessions
        .messages(sessionId)
        .find((m) => m.kind === "user")!;
      for (const [id, messageId] of [
        [sessionId, user.id],
        [sessionId, tool.id],
        [childId!, row!.id],
        [childId!, tool.id],
      ] as const) {
        const res = await chat.member.call("GET", path(id, messageId));
        expect(res.status).toBe(404);
      }
      // a child's result reads under its root alone
      const result = (id: string) =>
        chat.member.call(
          "GET",
          `/api/sessions/${id}/messages/${tool.id}/result`,
        );
      const ok = await result(sessionId);
      expect(ok.status).toBe(200);
      expect((await ok.json()).content).toContain("UTC");
      expect((await result(childId!)).status).toBe(404);
      const another = await startChat(chat, "other");
      another.script.reply("done");
      await settled(chat, another.sessionId);
      expect((await result(another.sessionId)).status).toBe(404);
      expect(
        (
          await erin.call(
            "GET",
            `/api/sessions/${sessionId}/messages/${tool.id}/result`,
          )
        ).status,
      ).toBe(404);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("answers only for a delegate row, whatever else a child hangs off", async () => {
    const chat = await subagentApp();
    try {
      const { script, sessionId } = await delegated(chat);
      script.toolRound([
        delegateCall("d1", "Read the clock."),
        clockCall("t1"),
      ]);
      script.end();
      (await waitScript(chat.scripted, 2)).reply("noon");
      (await waitScript(chat.scripted, 3)).reply("noon");
      await settled(chat, sessionId);
      const [childId] = childrenOf(chat, sessionId);
      const clock = chat.app.sessions
        .messages(sessionId)
        .find((m) => m.kind === "tool" && m.toolName === "datetime")!;
      // a link no runner writes: the child under the clock's row
      chat.app.db
        .query("update sessions set parent_message_id = ? where id = ?")
        .run(clock.id, childId!);
      const res = await chat.member.call(
        "GET",
        `/api/sessions/${sessionId}/messages/${clock.id}/child`,
      );
      expect(res.status).toBe(404);
    } finally {
      await chat.app.shutdown();
    }
  });
});
