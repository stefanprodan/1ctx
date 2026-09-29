// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A turn that opens with several user messages from several authors in
// a team chat: its rows, its one envelope, the wire, the capabilities,
// the uploads, admission, regenerate, fork and the download.

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import {
  MAX_TURN_MESSAGES,
  type TurnMessage,
} from "../../../src/server/runner/index.ts";
import { envelopeRow } from "../../../src/server/sessions/stream.ts";
import type { Message } from "../../../src/shared/contracts/session.ts";
import type { Wire } from "../../../src/shared/words.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  setLimits,
  startChat,
  tick,
  waitScript,
} from "../../helpers/chat.ts";
import { stage } from "./uploads-helpers.ts";

async function settled(chat: ChatApp, id: string) {
  for (let i = 0; i < 400; i++) {
    if (chat.app.sessions.byId(id)?.status !== "running") return;
    await tick();
  }
  throw new Error("send did not settle");
}

// a team chat the member started, its first turn answered
async function teamChat(chat: ChatApp): Promise<{
  projectId: string;
  sessionId: string;
  casey: string;
  admin: string;
}> {
  const created = await chat.admin.call("POST", "/api/projects", {
    body: { name: "ops", description: "A team project." },
  });
  expect(created.status).toBe(201);
  const projectId = (await created.json()).project.id as string;
  const added = await chat.admin.call(
    "POST",
    `/api/projects/${projectId}/members`,
    { body: { userId: chat.memberId } },
  );
  expect(added.status).toBe(201);
  const started = await startChat(chat, "first", chat.member, projectId);
  started.script.reply("first answer");
  await settled(chat, started.sessionId);
  return {
    projectId,
    sessionId: started.sessionId,
    casey: chat.memberId,
    admin: chat.adminId,
  };
}

const turnOf = (chat: ChatApp, sessionId: string): Message[] => {
  const rows = chat.app.sessions.messages(sessionId);
  const last = rows.findLast((row) => row.kind === "user")!;
  return rows.filter((row) => row.sendId === last.sendId);
};

const userMessages = (script: Script) =>
  (script.body.messages as { role: string; content: string; name?: string }[])
    .filter((message) => message.role === "user")
    .map(({ content, name }) => ({ content, name }));

describe("a turn of several user messages", () => {
  test.serial(
    "writes each message with its author in one envelope and one revision",
    async () => {
      const chat = await chatApp();
      try {
        const team = await teamChat(chat);
        const before = chat.app.sessions.byId(team.sessionId)!;
        const events: Extract<BusEvent, { type: "session.changed" }>[] = [];
        const unsubscribe = subscribe((event) => {
          if (
            event.type === "session.changed" &&
            event.data.session.id === team.sessionId
          ) {
            events.push(event);
          }
        }, silent);
        let detail: ReturnType<typeof chat.app.runner.sendTurn>;
        try {
          detail = chat.app.runner.sendTurn(team.sessionId, [
            { userId: team.casey, message: "one" },
            { userId: team.admin, message: "two" },
            { userId: team.casey, message: "three" },
          ]);
        } finally {
          unsubscribe();
        }
        expect(detail.session.revision).toBe(before.revision + 1);
        expect(events).toHaveLength(1);
        const rows = events[0]!.data.messages;
        expect(rows.map((row) => [row.kind, row.content, row.userId])).toEqual([
          ["user", "one", team.casey],
          ["user", "two", team.admin],
          ["user", "three", team.casey],
          ["reply", "", null],
        ]);
        expect(new Set(rows.map((row) => row.sendId)).size).toBe(1);
        expect(rows[1]!.seq).toBe(rows[0]!.seq + 1);
        expect(rows[2]!.seq).toBe(rows[1]!.seq + 1);
        expect(events[0]!.data.send?.firstMessageId).toBe(rows[0]!.id);
        expect(events[0]!.data.last).toEqual({
          seq: rows[2]!.seq,
          author: "casey",
          text: "three",
        });
        expect(envelopeRow(chat.app.db, team.sessionId)?.last).toEqual({
          seq: rows[2]!.seq,
          author: "casey",
          text: "three",
        });

        // the send counts against the first author
        const active = chat.app.runner.registry.get(team.sessionId)!;
        expect(active.startedBy).toBe(team.casey);
        expect(active.policy.userId).toBe(team.casey);

        const script = await waitScript(chat.scripted, 2);
        expect(userMessages(script)).toEqual([
          { content: "first", name: "casey" },
          { content: "one", name: "casey" },
          { content: "two", name: "admin" },
          { content: "three", name: "casey" },
        ]);
        script.reply("all three read");
        await settled(chat, team.sessionId);
        expect(envelopeRow(chat.app.db, team.sessionId)?.last).toMatchObject({
          author: "coder",
          text: "all three read",
        });
      } finally {
        await chat.app.shutdown();
      }
    },
  );

  test.each(["openai-compatible", "openai-strict", "gemini"] as Wire[])(
    "the %s wire carries each message with its author",
    async (wire) => {
      const chat = await chatApp({ wire });
      try {
        const team = await teamChat(chat);
        chat.app.runner.sendTurn(team.sessionId, [
          { userId: team.admin, message: "left" },
          { userId: team.casey, message: "right" },
        ]);
        const script = await waitScript(chat.scripted, 2);
        expect(userMessages(script).slice(-2)).toEqual([
          { content: "left", name: "admin" },
          { content: "right", name: "casey" },
        ]);
        script.reply("done");
        await settled(chat, team.sessionId);
      } finally {
        await chat.app.shutdown();
      }
    },
  );

  test("the first author's cap refuses the turn", async () => {
    const chat = await chatApp();
    try {
      const team = await teamChat(chat);
      await setLimits(chat, { sendsPerUser: 1 });
      const other = await startChat(chat, "busy", chat.admin, team.projectId);
      expect(() =>
        chat.app.runner.sendTurn(team.sessionId, [
          { userId: team.admin, message: "one" },
          { userId: team.casey, message: "two" },
        ]),
      ).toThrow(/going/);
      expect(turnOf(chat, team.sessionId).map((row) => row.content)).toEqual([
        "first",
        "first answer",
      ]);
      const detail = chat.app.runner.sendTurn(team.sessionId, [
        { userId: team.casey, message: "one" },
        { userId: team.admin, message: "two" },
      ]);
      expect(chat.app.runner.registry.get(detail.session.id)?.startedBy).toBe(
        team.casey,
      );
      (await waitScript(chat.scripted, 3)).reply("done");
      other.script.reply("done");
      await settled(chat, team.sessionId);
      await settled(chat, other.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("applies capability changes in order, the later winning", async () => {
    const chat = await chatApp();
    try {
      const team = await teamChat(chat);
      const detail = chat.app.runner.sendTurn(team.sessionId, [
        {
          userId: team.casey,
          message: "one",
          capabilities: { disable: ["web", "memory"] },
        },
        {
          userId: team.admin,
          message: "two",
          capabilities: { enable: ["web"], disable: ["visualize"] },
        },
      ]);
      expect(detail.session.disabledCapabilities).toEqual([
        "memory",
        "visualize",
      ]);
      const active = chat.app.runner.registry.get(team.sessionId)!;
      expect(active.policy.disabledCapabilities).toEqual([
        "memory",
        "visualize",
      ]);
      (await waitScript(chat.scripted, 2)).reply("done");
      await settled(chat, team.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("claims each message's uploads against its author", async () => {
    const chat = await chatApp();
    try {
      const team = await teamChat(chat);
      const mine = await stage(
        chat,
        "casey.md",
        "from casey",
        chat.member,
        team.projectId,
      );
      const theirs = await stage(
        chat,
        "admin.md",
        "from admin",
        chat.admin,
        team.projectId,
      );
      // an author cannot attach another's staged file
      expect(() =>
        chat.app.runner.sendTurn(team.sessionId, [
          { userId: team.casey, message: "one", uploads: [theirs.id] },
        ]),
      ).toThrow(/is gone/);
      chat.app.runner.sendTurn(team.sessionId, [
        { userId: team.casey, message: "one", uploads: [mine.id] },
        { userId: team.admin, message: "two", uploads: [theirs.id] },
        { userId: team.casey, message: "three" },
      ]);
      const users = turnOf(chat, team.sessionId).filter(
        (row) => row.kind === "user",
      );
      expect(
        users.map((row) => row.uploads?.map((item) => item.name) ?? null),
      ).toEqual([["casey.md"], ["admin.md"], null]);
      const script = await waitScript(chat.scripted, 2);
      const sent = userMessages(script).slice(-3);
      expect(sent[0]!.content).toContain("casey.md");
      expect(sent[1]!.content).toContain("admin.md");
      script.reply("done");
      await settled(chat, team.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("refuses a list out of bounds and a reader who cannot see the chat", async () => {
    const chat = await chatApp();
    try {
      const team = await teamChat(chat);
      const one = { userId: team.casey, message: "x" };
      const refused: [TurnMessage[], RegExp][] = [
        [[], /1 to 16/],
        [Array.from({ length: MAX_TURN_MESSAGES + 1 }, () => one), /1 to 16/],
        [[one, { userId: team.admin, message: " " }], /message/],
        [
          [
            one,
            {
              userId: team.admin,
              message: "y",
              uploads: Array.from({ length: 11 }, (_, i) => `u${i}`),
            },
          ],
          /uploads/,
        ],
      ];
      // one staged file in two messages would fail the second claim
      refused.push([
        [
          { ...one, uploads: ["same"] },
          { userId: team.admin, message: "y", uploads: ["same"] },
        ],
        /each file can be added to one message/,
      ]);
      for (const [messages, error] of refused) {
        expect(() =>
          chat.app.runner.sendTurn(team.sessionId, messages),
        ).toThrow(error);
      }
      // the member's personal chat is not the admin's to write in
      const personal = await startChat(chat, "mine");
      personal.script.reply("done");
      await settled(chat, personal.sessionId);
      expect(() =>
        chat.app.runner.sendTurn(personal.sessionId, [
          { userId: team.casey, message: "one" },
          { userId: team.admin, message: "two" },
        ]),
      ).toThrow(/no such chat/);
      expect(chat.app.sessions.messages(personal.sessionId)).toHaveLength(2);
      expect(chat.app.sessions.messages(team.sessionId)).toHaveLength(2);
      expect(chat.app.runner.registry.size).toBe(0);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("reads each author as they are when the turn starts", async () => {
    const chat = await chatApp();
    try {
      const team = await teamChat(chat);
      const other = chat.app.createUser({
        username: "dana",
        fullName: "Dana Roe",
        email: "dana@example.com",
        role: "admin",
        passwordHash: "x",
        mustChangePassword: false,
        now: chat.app.now.value,
      });
      const turn: TurnMessage[] = [
        { userId: team.casey, message: "one" },
        { userId: other.id, message: "two" },
      ];
      // an admin demoted since writing no longer sees a project they
      // are not a member of
      chat.app.db
        .query("update users set role = 'member' where id = ?")
        .run(other.id);
      expect(() => chat.app.runner.sendTurn(team.sessionId, turn)).toThrow(
        /no such chat/,
      );
      // a member removed from the project since writing
      const removed = await chat.admin.call(
        "DELETE",
        `/api/projects/${team.projectId}/members/${team.casey}`,
      );
      expect(removed.status).toBe(200);
      expect(() =>
        chat.app.runner.sendTurn(team.sessionId, [
          { userId: team.admin, message: "one" },
          { userId: team.casey, message: "two" },
        ]),
      ).toThrow(/no such chat/);
      chat.app.db
        .query("update users set disabled = 1 where id = ?")
        .run(other.id);
      expect(() =>
        chat.app.runner.sendTurn(team.sessionId, [
          { userId: other.id, message: "one" },
        ]),
      ).toThrow("the user is disabled");
      expect(() =>
        chat.app.runner.sendTurn(team.sessionId, [
          { userId: "gone00000000", message: "one" },
        ]),
      ).toThrow("the user is gone");
      expect(chat.app.sessions.messages(team.sessionId)).toHaveLength(2);
      expect(chat.app.runner.registry.size).toBe(0);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("regenerate redoes the whole turn", async () => {
    const chat = await chatApp();
    try {
      const team = await teamChat(chat);
      chat.app.runner.sendTurn(team.sessionId, [
        { userId: team.casey, message: "one" },
        { userId: team.admin, message: "two" },
      ]);
      (await waitScript(chat.scripted, 2)).reply("old");
      await settled(chat, team.sessionId);
      const old = turnOf(chat, team.sessionId);
      const users = old.filter((row) => row.kind === "user");
      const reply = old.find((row) => row.kind === "reply")!;

      const response = await chat.member.call(
        "POST",
        `/api/sessions/${team.sessionId}/regenerate`,
      );
      expect(response.status).toBe(201);
      const detail = await response.json();
      const moved = (detail.messages as Message[]).filter(
        (row) => row.sendId === detail.send.id,
      );
      expect(moved.map((row) => [row.id, row.kind])).toEqual([
        [users[0]!.id, "user"],
        [users[1]!.id, "user"],
        [expect.any(String), "reply"],
      ]);
      expect(detail.send.firstMessageId).toBe(users[0]!.id);
      expect(chat.app.sessions.send(reply.sendId)).toBeNull();
      expect(
        (detail.messages as Message[]).some((row) => row.id === reply.id),
      ).toBeFalse();
      const script = await waitScript(chat.scripted, 3);
      expect(userMessages(script)).toEqual([
        { content: "first", name: "casey" },
        { content: "one", name: "casey" },
        { content: "two", name: "admin" },
      ]);
      // the line names the last message's author, not who regenerated
      expect(envelopeRow(chat.app.db, team.sessionId)?.last).toMatchObject({
        author: "admin",
        text: "two",
      });
      script.reply("new");
      await settled(chat, team.sessionId);
      expect(
        turnOf(chat, team.sessionId).map((row) => [row.kind, row.content]),
      ).toEqual([
        ["user", "one"],
        ["user", "two"],
        ["reply", "new"],
      ]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("fork at the second message keeps the first and drafts the second", async () => {
    const chat = await chatApp();
    try {
      const team = await teamChat(chat);
      chat.app.runner.sendTurn(team.sessionId, [
        { userId: team.casey, message: "one" },
        { userId: team.admin, message: "two" },
      ]);
      (await waitScript(chat.scripted, 2)).reply("answer");
      await settled(chat, team.sessionId);
      const second = turnOf(chat, team.sessionId).find(
        (row) => row.content === "two",
      )!;
      const response = await chat.member.call(
        "POST",
        `/api/sessions/${team.sessionId}/fork`,
        { body: { messageId: second.id, agentId: chat.agentId } },
      );
      expect(response.status).toBe(201);
      const fork = await response.json();
      expect(
        (fork.messages as Message[]).map((row) => [row.kind, row.content]),
      ).toEqual([
        ["user", "first"],
        ["reply", "first answer"],
        ["user", "one"],
      ]);
      expect(fork.draftUploads).toEqual([]);

      // the next turn in the fork follows the kept message, which is its
      // own send's and stays when the next turn is regenerated
      const next = chat.scripted.next();
      expect(
        (
          await chat.member.call(
            "POST",
            `/api/sessions/${fork.session.id}/messages`,
            { body: { message: "two again" } },
          )
        ).status,
      ).toBe(201);
      const sent = await next;
      expect(userMessages(sent).slice(-2)).toEqual([
        { content: "one", name: "casey" },
        { content: "two again", name: "casey" },
      ]);
      sent.reply("forked answer");
      await settled(chat, fork.session.id);
      const again = chat.scripted.next();
      const regenerated = await chat.member.call(
        "POST",
        `/api/sessions/${fork.session.id}/regenerate`,
      );
      expect(regenerated.status).toBe(201);
      const detail = await regenerated.json();
      const rows = detail.messages as Message[];
      expect(
        rows
          .filter((row) => row.sendId === detail.send.id)
          .map((row) => [row.kind, row.content]),
      ).toEqual([
        ["user", "two again"],
        ["reply", ""],
      ]);
      const kept = rows.find((row) => row.content === "one")!;
      expect(kept.sendId).not.toBe(detail.send.id);
      expect(chat.app.sessions.send(kept.sendId)).not.toBeNull();
      (await again).reply("done");
      await settled(chat, fork.session.id);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the download names each message's author", async () => {
    const chat = await chatApp();
    try {
      const team = await teamChat(chat);
      chat.app.runner.sendTurn(team.sessionId, [
        { userId: team.casey, message: "one" },
        { userId: team.admin, message: "two" },
      ]);
      (await waitScript(chat.scripted, 2)).reply("both");
      await settled(chat, team.sessionId);
      const response = await chat.member.call(
        "GET",
        `/api/sessions/${team.sessionId}/markdown?tz=UTC`,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      const headings = text
        .split("\n")
        .filter((line) => line.startsWith("## @"))
        .map((line) => line.split(" ")[1]);
      expect(headings).toEqual([
        "@casey",
        "@coder",
        "@casey",
        "@admin",
        "@coder",
      ]);
      expect(text).toMatch(
        /## @casey [^\n]+\n\none\n\n## @admin [^\n]+\n\ntwo\n\n## @coder [^\n]+\n\nboth\n/,
      );
    } finally {
      await chat.app.shutdown();
    }
  });
});
