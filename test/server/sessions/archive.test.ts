// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { acquireSession } from "../../../src/server/knowledge/queue.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { Conflict } from "../../../src/server/lib/errors.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import type { SendPolicy } from "../../../src/server/runner/policy.ts";
import { type StartDeps, startSend } from "../../../src/server/runner/start.ts";
import { startCompact } from "../../../src/server/runner/summary.ts";
import { sweepChats } from "../../../src/server/sessions/sweep.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import { collectLogs } from "../../helpers/app.ts";
import {
  createAutomation,
  settleRun as settle,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  setLimits,
  startChat,
  tick,
} from "../../helpers/chat.ts";

const DAY = 86_400_000;
const ARCHIVED = { error: "the chat is archived" };

async function doneChat(
  chat: ChatApp,
  message = "hello",
  client = chat.member,
) {
  const started = await startChat(chat, message, client);
  started.script.reply("the answer");
  await settle(chat, started.sessionId);
  return started.sessionId;
}

async function detail(chat: ChatApp, id: string): Promise<SessionDetail> {
  const res = await chat.member.call("GET", `/api/sessions/${id}`);
  expect(res.status).toBe(200);
  return res.json();
}

function archive(chat: ChatApp, id: string, client = chat.member) {
  return client.call("POST", `/api/sessions/${id}/archive`);
}

function idleFor(chat: ChatApp, id: string, days: number) {
  chat.app.db
    .query("update sessions set last_activity_at = ? where id = ?")
    .run(chat.app.now.value - days * DAY, id);
}

function addScratch(chat: ChatApp, id: string) {
  chat.app.db
    .query(
      `insert into session_scratch
         (session_id, cwd, revision, bytes, files, used_at)
       values (?, '/', 1, 0, 0, ?)`,
    )
    .run(id, chat.app.now.value);
}

function scratchOf(chat: ChatApp): string[] {
  return chat.app.db
    .query<{ id: string }, []>(
      "select session_id as id from session_scratch order by session_id",
    )
    .all()
    .map((row) => row.id);
}

describe("an archived chat is read-only", () => {
  test("send, regenerate, compact and rename are 409s; stop is allowed", async () => {
    const chat = await chatApp();
    const id = await doneChat(chat);
    expect((await archive(chat, id)).status).toBe(204);
    const refused = [
      await chat.member.call("POST", `/api/sessions/${id}/messages`, {
        body: { message: "again" },
      }),
      await chat.member.call("POST", `/api/sessions/${id}/regenerate`),
      await chat.member.call("POST", `/api/sessions/${id}/compact`),
      await chat.member.call("PATCH", `/api/sessions/${id}`, {
        body: { title: "renamed" },
      }),
    ];
    for (const res of refused) {
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(ARCHIVED);
    }
    expect(
      (await chat.member.call("POST", `/api/sessions/${id}/stop`)).status,
    ).toBe(200);
    const shown = await detail(chat, id);
    expect(shown.session.title).toBe("hello");
    expect(shown.messages).toHaveLength(2);
    await chat.app.shutdown();
  });

  test("a chat on a deleted agent says archived, not no such agent", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    const id = await doneChat(chat);
    expect(
      (await chat.admin.call("DELETE", `/api/agents/${chat.agentId}`)).status,
    ).toBe(200);
    for (const [path, body] of [
      ["messages", { message: "again" }],
      ["regenerate", undefined],
      ["compact", undefined],
    ] as const) {
      const res = await chat.member.call(
        "POST",
        `/api/sessions/${id}/${path}`,
        { body },
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(ARCHIVED);
    }
    await chat.app.shutdown();
  });

  test("the send and compact transactions refuse a row archived since it was read", async () => {
    const chat = await chatApp();
    const id = await doneChat(chat);
    const stale = chat.app.sessions.byId(id)!;
    chat.app.sessions.archive(id, "idle", null, chat.app.now.value);
    const policy = {} as SendPolicy;
    const deps: StartDeps = {
      db: chat.app.db,
      clock: () => chat.app.now.value,
      sessions: chat.app.sessions,
      uploads: {} as StartDeps["uploads"],
      views: { start() {}, resetSeen() {} },
    };
    expect(() =>
      startSend(deps, {
        sendId: "send1",
        replyId: "reply1",
        userId: "user1",
        sessionId: id,
        session: stale,
        title: stale.title,
        policy,
        text: "again",
        mcpDigest: null,
      }),
    ).toThrow(new Conflict("the chat is archived"));
    expect(() =>
      startCompact(
        {
          db: chat.app.db,
          clock: () => chat.app.now.value,
          sessions: chat.app.sessions,
          usage: { record() {} },
          render: (text) => text,
          stream() {},
        },
        {
          sendId: "send1",
          summaryId: "summary1",
          firstMessageId: "user1",
          session: stale,
          policy,
        },
      ),
    ).toThrow(new Conflict("the chat is archived"));
    expect(chat.app.sessions.lastSend(id)!.kind).toBe("chat");
    await chat.app.shutdown();
  });

  test("fork takes an archived chat, onto a live agent only", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    const id = await doneChat(chat);
    expect((await archive(chat, id)).status).toBe(204);
    const answer = (await detail(chat, id)).messages.find(
      (row) => row.kind === "reply" && row.slot === "answer",
    )!;
    const forked = await chat.member.call("POST", `/api/sessions/${id}/fork`, {
      body: { messageId: answer.id, agentId: chat.agentId },
    });
    expect(forked.status).toBe(201);
    expect((await forked.json()).session.archived).toBeNull();
    expect(
      (await chat.admin.call("DELETE", `/api/agents/${chat.agentId}`)).status,
    ).toBe(200);
    const retired = await chat.member.call("POST", `/api/sessions/${id}/fork`, {
      body: { messageId: answer.id, agentId: chat.agentId },
    });
    expect(retired.status).toBe(400);
    expect(await retired.json()).toEqual({ error: "no such agent" });
    await chat.app.shutdown();
  });
});

describe("archiving by hand", () => {
  test.serial("archives once, as the caller, with one envelope", async () => {
    const chat = await chatApp();
    const id = await doneChat(chat);
    addScratch(chat, id);
    const events: BusEvent[] = [];
    const unsubscribe = subscribe((event) => events.push(event), silent);
    const res = await archive(chat, id);
    unsubscribe();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const shown = await detail(chat, id);
    expect(shown.session.archived).toEqual({
      at: chat.app.now.value,
      reason: "manual",
    });
    expect(shown.archive).toEqual({
      by: { id: chat.memberId, username: "casey" },
      keptUntil: chat.app.now.value + DEFAULT_LIMITS.archivedDeleteDays * DAY,
    });
    expect(
      events.flatMap((event) =>
        event.type === "session.changed" ? [event.data.session.id] : [],
      ),
    ).toEqual([id]);
    expect(scratchOf(chat)).toEqual([]);
    const again = await archive(chat, id);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: "the chat is archived already",
    });
    await chat.app.shutdown();
  });

  test("a running chat and a run are 409s", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    const started = await startChat(chat);
    started.script.content("partial");
    await tick();
    const running = await archive(chat, started.sessionId);
    expect(running.status).toBe(409);
    expect(await running.json()).toEqual({
      error: "the chat is running, stop it first",
    });
    started.script.reply(" done");
    await settle(chat, started.sessionId);
    const automation = await createAutomation(chat);
    const run = await startRun(chat, automation.id);
    run.main.reply("healthy");
    await settle(chat, run.sessionId);
    const refused = await archive(chat, run.sessionId);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "a run cannot be archived",
    });
    expect(chat.app.sessions.byId(started.sessionId)!.archived).toBeNull();
    await chat.app.shutdown();
  });

  test("a member archives a team chat someone else started", async () => {
    const chat = await chatApp();
    const created = await chat.admin.call("POST", "/api/projects", {
      body: { name: "shared", description: "" },
    });
    const { project } = await created.json();
    expect(
      (
        await chat.admin.call("POST", `/api/projects/${project.id}/members`, {
          body: { userId: chat.memberId },
        })
      ).status,
    ).toBe(201);
    const started = await startChat(chat, "team work", chat.admin, project.id);
    started.script.reply("done");
    await settle(chat, started.sessionId);
    expect((await archive(chat, started.sessionId)).status).toBe(204);
    expect((await detail(chat, started.sessionId)).archive!.by).toEqual({
      id: chat.memberId,
      username: "casey",
    });
    await chat.app.shutdown();
  });
});

describe("the chats sweep", () => {
  test.serial(
    "archives chats idle past the limit, one envelope each, and logs the count",
    async () => {
      const { events: logs, logFactory } = collectLogs();
      const chat = await chatApp({ logFactory });
      chat.app.automationScheduler.stop();
      const old = await doneChat(chat, "old");
      const recent = await doneChat(chat, "recent");
      const automation = await createAutomation(chat);
      const run = await startRun(chat, automation.id);
      run.main.reply("healthy");
      await settle(chat, run.sessionId);
      const streaming = await startChat(chat, "streaming");
      streaming.script.content("partial");
      await tick();
      idleFor(chat, old, 31);
      idleFor(chat, recent, 29);
      idleFor(chat, run.sessionId, 400);
      idleFor(chat, streaming.sessionId, 31);

      const events: BusEvent[] = [];
      const unsubscribe = subscribe((event) => events.push(event), silent);
      chat.app.sweep();
      unsubscribe();
      expect(chat.app.sessions.byId(old)!.archived).toEqual({
        at: chat.app.now.value,
        reason: "idle",
      });
      for (const id of [recent, run.sessionId, streaming.sessionId]) {
        expect(chat.app.sessions.byId(id)!.archived).toBeNull();
      }
      expect(
        events.flatMap((event) =>
          event.type === "session.changed" ? [event.data.session.id] : [],
        ),
      ).toEqual([old]);
      expect(
        logs.filter((event) => event.area === "sweep" && event.msg === "sweep"),
      ).toEqual([
        expect.objectContaining({
          fields: expect.objectContaining({
            chats_archived: 1,
            scratch_freed: 0,
          }),
        }),
      ]);

      // a lower limit takes the next chat at the next sweep
      await setLimits(chat, { archiveIdleDays: 10 });
      chat.app.sweep();
      expect(chat.app.sessions.byId(recent)!.archived).toMatchObject({
        reason: "idle",
      });
      expect(chat.app.sessions.byId(run.sessionId)!.archived).toBeNull();

      // nothing left to do, nothing logged
      const before = logs.length;
      streaming.script.reply(" done");
      await settle(chat, streaming.sessionId);
      chat.app.sweep();
      expect(
        logs
          .slice(before)
          .filter((event) => event.area === "sweep" && event.msg === "sweep"),
      ).toEqual([]);
      expect(chat.app.sessions.byId(streaming.sessionId)!.archived).toBeNull();
      await chat.app.shutdown();
    },
  );

  test.serial(
    "frees the scratch of archived chats that no command holds",
    async () => {
      const { events: logs, logFactory } = collectLogs();
      const chat = await chatApp({ logFactory });
      const live = await doneChat(chat, "live");
      const archived = await doneChat(chat, "archived");
      expect((await archive(chat, archived)).status).toBe(204);
      // written after the archive, as a send stopping late can
      addScratch(chat, archived);
      addScratch(chat, live);
      const release = await acquireSession(
        archived,
        new AbortController().signal,
      );
      chat.app.sweep();
      expect(scratchOf(chat).sort()).toEqual([archived, live].sort());
      release();
      chat.app.sweep();
      expect(scratchOf(chat)).toEqual([live]);
      expect(
        logs.filter((event) => event.area === "sweep" && event.msg === "sweep"),
      ).toEqual([
        expect.objectContaining({
          fields: expect.objectContaining({
            chats_archived: 0,
            scratch_freed: 1,
          }),
        }),
      ]);
      await chat.app.shutdown();
    },
  );

  test.serial(
    "an agent's delete keeps a held scratch until the sweep after release",
    async () => {
      const chat = await chatApp();
      chat.app.automationScheduler.stop();
      const id = await doneChat(chat, "held");
      addScratch(chat, id);
      const release = await acquireSession(id, new AbortController().signal);
      expect(
        (await chat.admin.call("DELETE", `/api/agents/${chat.agentId}`)).status,
      ).toBe(200);
      expect(chat.app.sessions.byId(id)!.archived).toMatchObject({
        reason: "agent",
      });
      expect(scratchOf(chat)).toEqual([id]);
      chat.app.sweep();
      expect(scratchOf(chat)).toEqual([id]);
      release();
      chat.app.sweep();
      expect(scratchOf(chat)).toEqual([]);
      await chat.app.shutdown();
    },
  );

  test("a step whose query throws is logged and the next steps run", async () => {
    const chat = await chatApp();
    const old = await doneChat(chat, "old");
    const gone = await doneChat(chat, "gone");
    idleFor(chat, old, 31);
    expect((await archive(chat, gone)).status).toBe(204);
    chat.app.db
      .query("update sessions set archived_at = ? where id = ?")
      .run(chat.app.now.value - 400 * DAY, gone);
    const { events, logFactory } = collectLogs();
    const deps = {
      db: chat.app.db,
      store: chat.app.sessions,
      scratch: {
        drop() {},
        held(): ReadonlySet<string> {
          throw new Error("held broke");
        },
      },
      log: logFactory("sweep"),
    };
    expect(sweepChats(deps, chat.app.now.value, DEFAULT_LIMITS)).toMatchObject({
      chats_archived: 1,
      scratch_freed: 0,
      chats_deleted: 1,
    });
    expect(events).toEqual([
      expect.objectContaining({
        level: "warn",
        msg: "chat sweep failed",
        fields: expect.objectContaining({
          step: "scratch_freed",
          error: "held broke",
        }),
      }),
    ]);
    await chat.app.shutdown();
  });

  test("each step takes at most its cap per pass", async () => {
    const chat = await chatApp();
    const ids = [
      await doneChat(chat, "one"),
      await doneChat(chat, "two"),
      await doneChat(chat, "three"),
    ];
    idleFor(chat, ids[0]!, 33);
    idleFor(chat, ids[1]!, 32);
    idleFor(chat, ids[2]!, 31);
    const deps = {
      db: chat.app.db,
      store: chat.app.sessions,
      scratch: chat.app.knowledge.scratch,
      log: silent,
    };
    const caps = DEFAULT_LIMITS;
    expect(sweepChats(deps, chat.app.now.value, caps, 2)).toMatchObject({
      chats_archived: 2,
      scratch_freed: 0,
    });
    expect(chat.app.sessions.byId(ids[2]!)!.archived).toBeNull();
    expect(sweepChats(deps, chat.app.now.value, caps, 2)).toMatchObject({
      chats_archived: 1,
      scratch_freed: 0,
    });
    await chat.app.shutdown();
  });
});
