// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A message sent to a busy chat waits as a queued row and the chat's
// whole queue starts as one turn when the reply ends: the dispatcher's
// order against the caps and the scheduler, its bounds, the claim that
// an edit races, expiry, what turns a row not sent, and shutdown.

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import type { QueuedMessage } from "../../../src/shared/contracts/session.ts";
import { hashPassword, testApp } from "../../helpers/app.ts";
import { createAutomation, settleRun } from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  FLASH,
  type Script,
  setLimits,
  startChat,
  tick,
  waitScript,
} from "../../helpers/chat.ts";
import { createTeam } from "../../helpers/projects.ts";
import {
  stage,
  send as uploadSend,
  start as uploadStart,
} from "./uploads-helpers.ts";

const HOUR = 3_600_000;

async function send(
  chat: ChatApp,
  sessionId: string,
  message: string,
  client = chat.member,
  extra: Record<string, unknown> = {},
) {
  return client.call("POST", `/api/sessions/${sessionId}/messages`, {
    body: { message, ...extra },
  });
}

async function queue(
  chat: ChatApp,
  sessionId: string,
  message: string,
  client = chat.member,
  extra: Record<string, unknown> = {},
): Promise<QueuedMessage> {
  const response = await send(chat, sessionId, message, client, extra);
  if (response.status !== 202) {
    throw new Error(
      `queue answered ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()).queued;
}

const rows = (chat: ChatApp, sessionId: string) =>
  chat.app.db
    .query<{ content: string; state: string; reason: string | null }, [string]>(
      "select content, state, reason from queued_messages where session_id = ? order by queued_at, rowid",
    )
    .all(sessionId);

const userMessages = (script: Script) =>
  (script.body.messages as { role: string; content: string; name?: string }[])
    .filter((message) => message.role === "user")
    .map(({ content, name }) => ({ content, name }));

const archive = () => new Bun.Archive({ "readme.md": "nested" }).bytes();

// a chat of the member's that holds a file named docs
async function withDocs(chat: ChatApp) {
  const docs = await stage(chat, "docs", "root file");
  const started = await uploadStart(chat, [docs.id]);
  started.script.reply("done");
  await settleRun(chat, started.sessionId);
  return started;
}

// the admin's own project, where their chats count against them alone
const adminProject = (chat: ChatApp) =>
  chat.app.projects.personal(chat.adminId)!.id;

// a team chat of the member's with the admin in the project too
async function teamChat(chat: ChatApp) {
  const team = await createTeam(chat.admin, "ops", [chat.memberId]);
  const started = await startChat(chat, "first", chat.member, team.id);
  return { projectId: team.id, ...started };
}

describe("the queue behind a busy chat", () => {
  test.serial(
    "messages from two authors start as one turn after the running one",
    async () => {
      const chat = await chatApp();
      try {
        const { sessionId, script } = await teamChat(chat);
        const before = chat.app.sessions.byId(sessionId)!.revision;
        const events: BusEvent[] = [];
        const unsubscribe = subscribe((event) => {
          if (
            event.type === "session.changed" &&
            event.data.session.id === sessionId
          ) {
            events.push(event);
          }
        }, silent);
        const one = await queue(chat, sessionId, "one");
        const two = await queue(chat, sessionId, "two", chat.admin);
        const three = await queue(chat, sessionId, "three");
        unsubscribe();
        expect(one).toMatchObject({
          author: { id: chat.memberId, username: "casey" },
          text: "one",
          uploads: 0,
          state: "queued",
          reason: null,
          revision: 0,
        });
        expect(two.author.username).toBe("admin");
        // one revision and one envelope per message, no transcript row
        expect(events).toHaveLength(3);
        expect(chat.app.sessions.byId(sessionId)!.revision).toBe(before + 3);
        expect(chat.app.sessions.messages(sessionId)).toHaveLength(2);
        const seen = await (
          await chat.admin.call("GET", `/api/sessions/${sessionId}`)
        ).json();
        expect(seen.queued.map((row: QueuedMessage) => row.id)).toEqual([
          one.id,
          two.id,
          three.id,
        ]);

        script.reply("first answer");
        const next = await waitScript(chat.scripted, 2);
        expect(userMessages(next)).toEqual([
          { content: "first", name: "casey" },
          { content: "one", name: "casey" },
          { content: "two", name: "admin" },
          { content: "three", name: "casey" },
        ]);
        const turn = chat.app.sessions
          .messages(sessionId)
          .filter((row) => row.kind === "user")
          .slice(1);
        expect(turn.map((row) => [row.content, row.userId])).toEqual([
          ["one", chat.memberId],
          ["two", chat.adminId],
          ["three", chat.memberId],
        ]);
        expect(new Set(turn.map((row) => row.sendId)).size).toBe(1);
        expect(rows(chat, sessionId)).toEqual([]);
        // the turn counts against its oldest message's author
        expect(chat.app.runner.registry.get(sessionId)?.startedBy).toBe(
          chat.memberId,
        );
        next.reply("all read");
        await settleRun(chat, sessionId);
      } finally {
        await chat.app.shutdown();
      }
    },
  );

  test("Stop ends the turn and the queued message starts", async () => {
    const chat = await chatApp();
    try {
      const { sessionId, script } = await startChat(chat, "long one");
      await queue(chat, sessionId, "after the stop");
      const stopped = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/stop`,
      );
      expect(stopped.status).toBe(200);
      const next = await waitScript(chat.scripted, 2);
      expect(script.aborted).toBe(true);
      expect(userMessages(next).at(-1)).toEqual({
        content: "after the stop",
        name: "casey",
      });
      next.reply("done");
      await settleRun(chat, sessionId);
      expect(rows(chat, sessionId)).toEqual([]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a queued message takes a freed place before a due run", async () => {
    const chat = await chatApp();
    try {
      await setLimits(chat, { sendsPerProject: 4, sendsRunning: 4 });
      const held = [];
      for (const message of ["a", "b", "c"]) {
        held.push(
          await startChat(chat, message, chat.admin, adminProject(chat)),
        );
      }
      const mine = await startChat(chat, "mine");
      const automation = await createAutomation(chat);
      chat.app.db
        .query("update automations set next_at = ? where id = ?")
        .run(chat.app.now.value, automation.id);
      await chat.app.automationScheduler.pass();
      expect(chat.app.runner.registry.size).toBe(4);
      await queue(chat, mine.sessionId, "next");
      mine.script.reply("done");
      const next = await waitScript(chat.scripted, 5);
      expect(userMessages(next).at(-1)?.content).toBe("next");
      await chat.app.automationScheduler.pass();
      await tick();
      // the freed place went to the message; the run still waits
      expect(chat.app.runner.registry.size).toBe(4);
      expect(
        chat.app.runner.registry.values().every((send) => send.kind === "chat"),
      ).toBe(true);
      next.reply("done");
      for (const other of held) other.script.reply("done");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("at a full cap a message stays queued and starts ahead of the scheduler", async () => {
    const chat = await chatApp();
    try {
      await setLimits(chat, { sendsPerUser: 1 });
      const { sessionId, script } = await teamChat(chat);
      // the admin's own place is taken, so their message cannot start
      const other = await startChat(
        chat,
        "elsewhere",
        chat.admin,
        adminProject(chat),
      );
      await queue(chat, sessionId, "from the admin", chat.admin);
      script.reply("first answer");
      await settleRun(chat, sessionId);
      await tick();
      expect(rows(chat, sessionId)).toEqual([
        { content: "from the admin", state: "queued", reason: null },
      ]);
      expect(chat.app.runner.registry.get(sessionId)).toBeNull();

      // the scheduler hears the wake after the queue has started
      const seen: boolean[] = [];
      const wake = chat.app.automationScheduler.wake;
      chat.app.automationScheduler.wake = () => {
        seen.push(chat.app.runner.registry.get(sessionId) !== null);
        wake();
      };
      other.script.reply("done");
      const next = await waitScript(chat.scripted, 3);
      chat.app.automationScheduler.wake = wake;
      expect(seen[0]).toBe(true);
      expect(userMessages(next).at(-1)).toEqual({
        content: "from the admin",
        name: "admin",
      });
      expect(chat.app.runner.registry.get(sessionId)?.startedBy).toBe(
        chat.adminId,
      );
      next.reply("done");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an idle chat at a full cap is refused, nothing queued", async () => {
    const chat = await chatApp();
    try {
      await setLimits(chat, { sendsPerUser: 1 });
      const first = await startChat(chat, "first");
      first.script.reply("done");
      await settleRun(chat, first.sessionId);
      const busy = await startChat(chat, "busy");
      const refused = await send(chat, first.sessionId, "again");
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({
        error: "You have 1 chat or run going. Wait for one to end.",
      });
      expect(rows(chat, first.sessionId)).toEqual([]);
      busy.script.reply("done");
      await settleRun(chat, busy.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the ninth message per user and the seventeenth per chat are refused", async () => {
    const chat = await chatApp();
    try {
      const { sessionId, script } = await teamChat(chat);
      for (let i = 0; i < 8; i++) await queue(chat, sessionId, `m${i}`);
      const ninth = await send(chat, sessionId, "m8");
      expect(ninth.status).toBe(429);
      expect(await ninth.json()).toEqual({
        error: "You have 8 messages waiting. Send or discard one first.",
      });
      for (let i = 0; i < 8; i++) {
        await queue(chat, sessionId, `a${i}`, chat.admin);
      }
      await setLimits(chat, { queuedPerUser: 32 });
      const seventeenth = await send(chat, sessionId, "m9");
      expect(seventeenth.status).toBe(429);
      expect(await seventeenth.json()).toEqual({
        error:
          "This chat has 16 messages waiting. Try again when the reply ends.",
      });
      expect(rows(chat, sessionId)).toHaveLength(16);
      script.reply("done");
      const next = await waitScript(chat.scripted, 2);
      expect(
        userMessages(next)
          .slice(1)
          .map((m) => m.content),
      ).toEqual([
        ...Array.from({ length: 8 }, (_, i) => `m${i}`),
        ...Array.from({ length: 8 }, (_, i) => `a${i}`),
      ]);
      next.reply("done");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a file staged in another queued message is refused", async () => {
    const chat = await chatApp();
    try {
      const { sessionId, script } = await startChat(chat, "first");
      const item = await stage(chat, "notes.md");
      const first = await queue(chat, sessionId, "read it", chat.member, {
        uploads: [item.id],
      });
      expect(first.uploads).toBe(1);
      const again = await send(chat, sessionId, "and again", chat.member, {
        uploads: [item.id],
      });
      expect(again.status).toBe(400);
      script.reply("done");
      const next = await waitScript(chat.scripted, 2);
      expect(JSON.stringify(next.body.messages)).toContain("notes.md");
      next.reply("done");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an edit before the start lands in it and one after gets the 409", async () => {
    const chat = await chatApp();
    try {
      const { sessionId, script } = await startChat(chat, "first");
      const row = await queue(chat, sessionId, "draft");
      const edited = await chat.member.call(
        "PATCH",
        `/api/sessions/${sessionId}/queued/${row.id}`,
        { body: { message: "final", revision: row.revision } },
      );
      expect(edited.status).toBe(200);
      const { queued } = await edited.json();
      expect(queued).toMatchObject({
        text: "final",
        revision: 1,
        queuedAt: row.queuedAt,
      });
      // an edit naming the old revision lost to the one that landed
      const stale = await chat.member.call(
        "PATCH",
        `/api/sessions/${sessionId}/queued/${row.id}`,
        { body: { message: "lost", revision: row.revision } },
      );
      expect(stale.status).toBe(409);
      script.reply("done");
      const next = await waitScript(chat.scripted, 2);
      expect(userMessages(next).at(-1)?.content).toBe("final");
      for (const [method, body] of [
        ["PATCH", { message: "late", revision: 1 }],
        ["DELETE", { revision: 1 }],
      ] as const) {
        const late = await chat.member.call(
          method,
          `/api/sessions/${sessionId}/queued/${row.id}`,
          { body },
        );
        expect(late.status).toBe(409);
      }
      next.reply("done");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a start whose claim lost writes nothing and frees the lock", async () => {
    const chat = await chatApp();
    try {
      const first = await startChat(chat, "first");
      first.script.reply("done");
      await settleRun(chat, first.sessionId);
      const turns = chat.app.sessions.messages(first.sessionId).length;
      const row = chat.app.sessions.queue.insert({
        sessionId: first.sessionId,
        authorId: chat.memberId,
        text: "waiting",
        now: chat.app.now.value,
      });
      expect(() =>
        chat.app.runner.sendTurn(
          first.sessionId,
          [{ userId: chat.memberId, message: "waiting" }],
          [{ id: row.id, revision: row.revision + 1 }],
        ),
      ).toThrow("a waiting message changed");
      // the wake of the freed lock started the row at its own revision,
      // once: the lost start wrote no row
      const next = await waitScript(chat.scripted, 2);
      expect(userMessages(next).slice(-2)).toEqual([
        { content: "first", name: "casey" },
        { content: "waiting", name: "casey" },
      ]);
      expect(chat.app.sessions.messages(first.sessionId)).toHaveLength(
        turns + 2,
      );
      expect(rows(chat, first.sessionId)).toEqual([]);
      next.reply("done");
      await settleRun(chat, first.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a row past its wait turns not sent with no other activity", async () => {
    const chat = await chatApp();
    try {
      // the reply outlives the wait
      await setLimits(chat, { sendDeadlineMs: 4 * HOUR });
      const { sessionId, script } = await startChat(chat, "slow");
      await queue(chat, sessionId, "too late");
      const before = chat.app.sessions.byId(sessionId)!.revision;
      chat.app.now.value += HOUR - 1;
      await tick();
      expect(rows(chat, sessionId)[0]!.state).toBe("queued");
      chat.app.now.value += 1;
      await tick();
      expect(rows(chat, sessionId)).toEqual([
        { content: "too late", state: "not-sent", reason: "expired" },
      ]);
      expect(chat.app.sessions.byId(sessionId)!.revision).toBe(before + 1);
      script.reply("done");
      await settleRun(chat, sessionId);
      await tick();
      expect(chat.scripted.scripts).toHaveLength(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a lowered wait moves the expiry", async () => {
    const chat = await chatApp();
    try {
      const { sessionId, script } = await startChat(chat, "slow");
      await queue(chat, sessionId, "short wait");
      await setLimits(chat, { queuedMinutes: 10 });
      chat.app.now.value += 10 * 60_000;
      await tick();
      expect(rows(chat, sessionId)[0]).toMatchObject({
        state: "not-sent",
        reason: "expired",
      });
      script.reply("done");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("shutdown leaves rows queued and a restart expires the old ones", async () => {
    const chat = await chatApp();
    const { db } = chat.app;
    const { sessionId } = await startChat(chat, "slow");
    await queue(chat, sessionId, "kept");
    await queue(chat, sessionId, "stale");
    await chat.app.shutdown();
    expect(rows(chat, sessionId).map((row) => row.state)).toEqual([
      "queued",
      "queued",
    ]);
    // one waited past its time while the server was down
    db.query(
      "update queued_messages set queued_at = queued_at - ? where content = 'stale'",
    ).run(2 * HOUR);
    const app = await testApp({ db });
    try {
      expect(
        app.db
          .query<{ content: string; state: string; reason: string | null }, []>(
            "select content, state, reason from queued_messages order by content",
          )
          .all(),
      ).toEqual([{ content: "stale", state: "not-sent", reason: "expired" }]);
      // the kept one started on the repaired chat
      expect(app.runner.registry.get(sessionId)).not.toBeNull();
      expect(
        app.sessions
          .messages(sessionId)
          .filter((row) => row.kind === "user")
          .map((row) => row.content),
      ).toEqual(["slow", "kept"]);
    } finally {
      await app.shutdown();
    }
  });

  test("a deleted agent and an archived chat turn their rows not sent", async () => {
    const chat = await chatApp();
    try {
      const { sessionId } = await startChat(chat, "on the old agent");
      await queue(chat, sessionId, "never");
      const deleted = await chat.admin.call(
        "DELETE",
        `/api/agents/${chat.agentId}`,
      );
      expect(deleted.status).toBe(200);
      await settleRun(chat, sessionId);
      await tick();
      expect(rows(chat, sessionId)).toEqual([
        { content: "never", state: "not-sent", reason: "agent-deleted" },
      ]);
      expect(chat.scripted.scripts).toHaveLength(1);
    } finally {
      await chat.app.shutdown();
    }

    const other = await chatApp();
    try {
      await setLimits(other, { sendsPerUser: 1 });
      const { sessionId, script } = await teamChat(other);
      const busy = await startChat(
        other,
        "busy",
        other.admin,
        adminProject(other),
      );
      await queue(other, sessionId, "waits", other.admin);
      script.reply("done");
      await settleRun(other, sessionId);
      expect(rows(other, sessionId)[0]?.state).toBe("queued");
      // the archive wakes the queue, with no place freed
      const archived = await other.member.call(
        "POST",
        `/api/sessions/${sessionId}/archive`,
      );
      expect(archived.status).toBe(204);
      expect(rows(other, sessionId)).toEqual([
        { content: "waits", state: "not-sent", reason: "archived" },
      ]);
      busy.script.reply("done");
      await settleRun(other, busy.sessionId);
    } finally {
      await other.app.shutdown();
    }
  });

  test("an agent's delete turns an idle chat's waiting rows not sent at once", async () => {
    const chat = await chatApp();
    try {
      await setLimits(chat, { sendsPerUser: 1 });
      const spare = await chat.makeAgent({ name: "spare", model: FLASH });
      const { sessionId, script } = await teamChat(chat);
      const busy = await startChat(
        chat,
        "busy",
        chat.admin,
        adminProject(chat),
        spare,
      );
      await queue(chat, sessionId, "waits", chat.admin);
      script.reply("done");
      await settleRun(chat, sessionId);
      expect(rows(chat, sessionId)[0]?.state).toBe("queued");
      const deleted = await chat.admin.call(
        "DELETE",
        `/api/agents/${chat.agentId}`,
      );
      expect(deleted.status).toBe(200);
      expect(rows(chat, sessionId)).toEqual([
        { content: "waits", state: "not-sent", reason: "agent-deleted" },
      ]);
      busy.script.reply("done");
      await settleRun(chat, busy.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a queued file that clashes with the chat's turns not sent and the process goes on", async () => {
    const chat = await chatApp();
    try {
      const { sessionId } = await withDocs(chat);
      const busy = await uploadSend(chat, sessionId);
      const item = await stage(chat, "docs.tar", await archive());
      await queue(chat, sessionId, "read the archive", chat.member, {
        uploads: [item.id],
      });
      busy.script.reply("done");
      await settleRun(chat, sessionId);
      await tick();
      expect(rows(chat, sessionId)).toEqual([
        { content: "read the archive", state: "not-sent", reason: "failed" },
      ]);
      expect(chat.app.runner.registry.get(sessionId)).toBeNull();
      expect(chat.scripted.scripts).toHaveLength(2);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a clashing queued file left behind turns not sent on the next message", async () => {
    const chat = await chatApp();
    try {
      const { sessionId } = await withDocs(chat);
      const item = await stage(chat, "docs.tar", await archive());
      chat.app.sessions.queue.insert({
        sessionId,
        authorId: chat.memberId,
        text: "left behind",
        uploads: [item.id],
        now: chat.app.now.value,
      });
      const pending = chat.scripted.next();
      const sent = await send(chat, sessionId, "fresh");
      expect(sent.status).toBe(201);
      const next = await pending;
      expect(userMessages(next).at(-1)?.content).toBe("fresh");
      expect(rows(chat, sessionId)).toEqual([
        { content: "left behind", state: "not-sent", reason: "failed" },
      ]);
      next.reply("done");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("of two authors only the row that fails is not sent", async () => {
    const chat = await chatApp();
    try {
      const team = await createTeam(chat.admin, "ops", [chat.memberId]);
      const docs = await stage(chat, "docs", "root file", chat.member, team.id);
      const first = await chat.member.call("POST", "/api/sessions", {
        body: {
          projectId: team.id,
          agentId: chat.agentId,
          message: "first",
          uploads: [docs.id],
        },
      });
      expect(first.status).toBe(201);
      const sessionId = (await first.json()).session.id as string;
      (await waitScript(chat.scripted, 1)).reply("done");
      await settleRun(chat, sessionId);
      const running = await send(chat, sessionId, "second");
      expect(running.status).toBe(201);
      const script = await waitScript(chat.scripted, 2);
      const item = await stage(
        chat,
        "docs.tar",
        await archive(),
        chat.member,
        team.id,
      );
      await queue(chat, sessionId, "clashes", chat.member, {
        uploads: [item.id],
      });
      await queue(chat, sessionId, "plain", chat.admin);
      script.reply("done");
      const next = await waitScript(chat.scripted, 3);
      expect(userMessages(next).slice(-1)).toEqual([
        { content: "plain", name: "admin" },
      ]);
      expect(rows(chat, sessionId)).toEqual([
        { content: "clashes", state: "not-sent", reason: "failed" },
      ]);
      next.reply("done");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("chats whose authors are capped do not hold back the fifth", async () => {
    const chat = await chatApp();
    try {
      await setLimits(chat, {
        sendsPerUser: 1,
        sendsPerProject: 4,
        sendsRunning: 4,
      });
      const idle: string[] = [];
      for (const message of ["a", "b", "c", "d"]) {
        const done = await startChat(
          chat,
          message,
          chat.admin,
          adminProject(chat),
        );
        done.script.reply("done");
        await settleRun(chat, done.sessionId);
        idle.push(done.sessionId);
      }
      const mine = await startChat(chat, "mine");
      mine.script.reply("done");
      await settleRun(chat, mine.sessionId);
      // the admin's one place is taken, so their four chats wait
      const busy = await startChat(
        chat,
        "busy",
        chat.admin,
        adminProject(chat),
      );
      const at = chat.app.now.value;
      for (const [i, sessionId] of idle.entries()) {
        chat.app.sessions.queue.insert({
          sessionId,
          authorId: chat.adminId,
          text: `old ${i}`,
          now: at - 10 + i,
        });
      }
      chat.app.sessions.queue.insert({
        sessionId: mine.sessionId,
        authorId: chat.memberId,
        text: "newest",
        now: at,
      });
      const count = chat.scripted.scripts.length + 1;
      chat.app.runner.queue.wake();
      const next = await waitScript(chat.scripted, count);
      expect(userMessages(next).at(-1)?.content).toBe("newest");
      for (const sessionId of idle) {
        expect(rows(chat, sessionId)[0]?.state).toBe("queued");
      }
      next.reply("done");
      await settleRun(chat, mine.sessionId);
      busy.script.reply("done");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a capped oldest author does not hold back the others", async () => {
    const chat = await chatApp();
    try {
      await setLimits(chat, { sendsPerUser: 1 });
      const { sessionId, script } = await teamChat(chat);
      const other = await startChat(
        chat,
        "elsewhere",
        chat.admin,
        adminProject(chat),
      );
      await queue(chat, sessionId, "from the admin", chat.admin);
      await queue(chat, sessionId, "from casey");
      script.reply("first answer");
      const next = await waitScript(chat.scripted, 3);
      expect(userMessages(next).slice(-2)).toEqual([
        { content: "from the admin", name: "admin" },
        { content: "from casey", name: "casey" },
      ]);
      expect(chat.app.runner.registry.get(sessionId)?.startedBy).toBe(
        chat.memberId,
      );
      next.reply("done");
      other.script.reply("done");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("two authors' capability changes apply in order, the later winning", async () => {
    const chat = await chatApp();
    try {
      const { sessionId, script } = await teamChat(chat);
      await queue(chat, sessionId, "one", chat.member, {
        capabilities: { disable: ["web", "memory"] },
      });
      await queue(chat, sessionId, "two", chat.admin, {
        capabilities: { enable: ["web"], disable: ["visualize"] },
      });
      script.reply("done");
      const next = await waitScript(chat.scripted, 2);
      expect(chat.app.sessions.byId(sessionId)!.disabledCapabilities).toEqual([
        "memory",
        "visualize",
      ]);
      expect(
        chat.app.runner.registry.get(sessionId)?.policy.disabledCapabilities,
      ).toEqual(["memory", "visualize"]);
      next.reply("done");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an author who lost the chat loses their rows and the rest start", async () => {
    const chat = await chatApp();
    try {
      const dana = chat.app.createUser({
        username: "dana",
        fullName: "Dana Roe",
        email: "dana@example.com",
        role: "member",
        passwordHash: await hashPassword("pw"),
        mustChangePassword: false,
        now: chat.app.now.value,
      });
      const danaClient = chat.app.client();
      await danaClient.login("dana", "pw");
      const team = await createTeam(chat.admin, "ops", [
        chat.memberId,
        dana.id,
      ]);
      const { sessionId, script } = await startChat(
        chat,
        "first",
        chat.member,
        team.id,
      );
      await queue(chat, sessionId, "from dana", danaClient);
      await queue(chat, sessionId, "from casey");
      // a removal through the route drops the rows at once
      const removed = await chat.admin.call(
        "DELETE",
        `/api/projects/${team.id}/members/${dana.id}`,
      );
      expect(removed.status).toBe(200);
      expect(rows(chat, sessionId).map((row) => row.content)).toEqual([
        "from casey",
      ]);
      // one lost behind the router's back is dropped at the start
      await chat.admin.call("POST", `/api/projects/${team.id}/members`, {
        body: { userId: dana.id },
      });
      await queue(chat, sessionId, "dana again", danaClient);
      chat.app.db
        .query("delete from memberships where user_id = ?")
        .run(dana.id);
      script.reply("done");
      const next = await waitScript(chat.scripted, 2);
      expect(userMessages(next).slice(1)).toEqual([
        { content: "from casey", name: "casey" },
      ]);
      expect(rows(chat, sessionId)).toEqual([]);
      next.reply("done");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a message whose start fails turns not sent and the rest start", async () => {
    const chat = await chatApp();
    try {
      const { sessionId, script } = await teamChat(chat);
      const team = chat.app.sessions.byId(sessionId)!.projectId;
      const staged = await stage(chat, "lost.md", "text", chat.member, team);
      await queue(chat, sessionId, "with a file", chat.member, {
        uploads: [staged.id],
      });
      await queue(chat, sessionId, "plain", chat.admin);
      chat.app.db
        .query("delete from upload_staged where id = ?")
        .run(staged.id);
      script.reply("done");
      const next = await waitScript(chat.scripted, 2);
      expect(userMessages(next).slice(1)).toEqual([
        { content: "plain", name: "admin" },
      ]);
      expect(rows(chat, sessionId)).toEqual([
        { content: "with a file", state: "not-sent", reason: "failed" },
      ]);
      next.reply("done");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });
});
