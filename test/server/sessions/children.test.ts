// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A subagent's child session, written here as its rows alone: hidden
// from every route, list and count of sessions, its tokens counted, and
// archived, packed and deleted with its root.

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { DAY_MS } from "../../../src/server/lib/clock.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { month, range } from "../../../src/server/overview/range.ts";
import { scan } from "../../../src/server/overview/scan.ts";
import {
  agentActivity,
  personDays,
} from "../../../src/server/sessions/activity.ts";
import { PACK_FROM } from "../../../src/server/sessions/pack.ts";
import { KEPT_STILL } from "../../../src/server/sessions/pack-kept.ts";
import type { SessionsResponse } from "../../../src/shared/api/sessions.ts";
import { testApp } from "../../helpers/app.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import { type ChatApp, chatApp, startChat } from "../../helpers/chat.ts";
import { frames, watch, watcher } from "../../helpers/socket.ts";

const BIG = "x".repeat(PACK_FROM * 2);

async function doneChat(chat: ChatApp, message = "hello") {
  const started = await startChat(chat, message);
  started.script.reply("the answer");
  await settleRun(chat, started.sessionId);
  return started.sessionId;
}

// a finished manual run of a new task, the scheduler stopped
async function doneRun(chat: ChatApp, retentionDays = 30) {
  chat.app.automationScheduler.stop();
  const automation = await createAutomation(chat, { retentionDays });
  const run = await startRun(chat, automation.id);
  run.main.reply("healthy");
  await settleRun(chat, run.sessionId);
  return { automationId: automation.id, runId: run.sessionId };
}

const packed = (chat: ChatApp, sessionId: string): number =>
  chat.app.db
    .query<{ n: number }, [string]>(
      "select count(*) as n from messages where session_id = ? and packed is not null",
    )
    .get(sessionId)!.n;

const ago = (chat: ChatApp, id: string, days: number) =>
  chat.app.db
    .query("update sessions set last_activity_at = ? where id = ?")
    .run(chat.app.now.value - days * DAY_MS, id);

// the root's answer, which stands for the tool row that started a child
const answerOf = (chat: ChatApp, sessionId: string): string =>
  chat.app.db
    .query<{ id: string }, [string]>(
      `select id from messages where session_id = ? and kind = 'reply'
       order by seq desc limit 1`,
    )
    .get(sessionId)!.id;

// a child under the root, as the runner would leave one: its task, a
// large tool result, its answer, its send and one priced round; its
// send starts a minute after now. Its rows are named after it: the
// send `<child>-send`, the tool row `<child>-tool`
function addChild(
  chat: ChatApp,
  rootId: string,
  fields: { status?: "done" | "running"; at?: number } = {},
): string {
  const db = chat.app.db;
  const root = chat.app.sessions.byId(rootId)!;
  const at = fields.at ?? chat.app.now.value + 60_000;
  const status = fields.status ?? "done";
  const child = chat.app.sessions.create({
    projectId: root.projectId,
    ownerId: root.ownerId,
    agentId: root.agentId,
    origin: root.origin,
    parent: { sessionId: rootId, messageId: answerOf(chat, rootId) },
    title: "a task",
    status,
    now: at,
  });
  const send = `${child.id}-send`;
  db.query(
    `insert into sends (id, session_id, kind, user_id, agent_id,
       provider_id, provider_name, model, status, first_message_id,
       child, started_at, finished_at)
     values (?, ?, ?, ?, ?, ?, 'local', 'm', ?, ?, 1, ?, ?)`,
  ).run(
    send,
    child.id,
    root.origin === "chat" ? "chat" : "run",
    root.ownerId,
    root.agentId,
    chat.providerId,
    status,
    `${child.id}-task`,
    at,
    status === "running" ? null : at + 1000,
  );
  db.query(
    `insert into messages (id, session_id, seq, kind, send_id, round,
       user_id, content, status, created_at, finished_at)
     values (?, ?, 1, 'user', ?, 1, ?, 'look around', 'done', ?, ?)`,
  ).run(`${child.id}-task`, child.id, send, root.ownerId, at, at);
  db.query(
    `insert into messages (id, session_id, seq, kind, send_id, round,
       tool_call_id, tool_name, content, status, created_at, finished_at)
     values (?, ?, 2, 'tool', ?, 1, 'c1', 'bash', ?, ?, ?, ?)`,
  ).run(
    `${child.id}-tool`,
    child.id,
    send,
    BIG,
    status === "running" ? "streaming" : "done",
    at,
    at,
  );
  if (status === "done") {
    db.query(
      `insert into messages (id, session_id, seq, kind, send_id, round,
         slot, agent_id, model, content, status, created_at, finished_at)
       values (?, ?, 3, 'reply', ?, 2, 'answer', ?, 'm', 'found it',
         'done', ?, ?)`,
    ).run(`${child.id}-answer`, child.id, send, root.agentId, at, at);
  }
  db.query(
    `insert into usage (id, send_id, session_id, project_id, user_id,
       agent_id, provider_id, model, round, seq, prompt_tokens,
       completion_tokens, cost, created_at)
     values (?, ?, ?, ?, ?, ?, ?, 'm', 1, 1, 1000, 100, 0.5, ?)`,
  ).run(
    `${child.id}-usage`,
    send,
    child.id,
    root.projectId,
    root.ownerId,
    root.agentId,
    chat.providerId,
    at,
  );
  return child.id;
}

const count = (chat: ChatApp, sql: string, ...args: string[]): number =>
  chat.app.db.query<{ n: number }, string[]>(sql).get(...args)!.n;

const left = (chat: ChatApp, childId: string) => ({
  sessions: count(
    chat,
    "select count(*) as n from sessions where id = ?",
    childId,
  ),
  sends: count(
    chat,
    "select count(*) as n from sends where session_id = ?",
    childId,
  ),
  messages: count(
    chat,
    "select count(*) as n from messages where session_id = ?",
    childId,
  ),
  usage: count(
    chat,
    "select count(*) as n from usage where session_id = ?",
    childId,
  ),
});

describe("the links", () => {
  test("a child goes with its delegate row and with its root, its usage stays", async () => {
    const chat = await chatApp();
    const first = await doneChat(chat);
    const second = await doneChat(chat, "again");
    const byRow = addChild(chat, first);
    const byRoot = addChild(chat, second);
    expect(left(chat, byRow)).toEqual({
      sessions: 1,
      sends: 1,
      messages: 3,
      usage: 1,
    });
    // regeneration deletes the rows after the turn by message
    chat.app.db
      .query("delete from messages where id = ?")
      .run(answerOf(chat, first));
    expect(left(chat, byRow)).toEqual({
      sessions: 0,
      sends: 0,
      messages: 0,
      usage: 1,
    });
    const res = await chat.member.call("DELETE", `/api/sessions/${second}`);
    expect(res.status).toBe(200);
    expect(left(chat, byRoot)).toEqual({
      sessions: 0,
      sends: 0,
      messages: 0,
      usage: 1,
    });
    expect(chat.app.db.query("pragma foreign_key_check").all()).toEqual([]);
  });

  test("both links are set or neither, and each names a real row", async () => {
    const chat = await chatApp();
    const root = await doneChat(chat);
    const insert = (parent: string | null, message: string | null) =>
      chat.app.db
        .query(
          `insert into sessions (id, project_id, owner_id, agent_id, origin,
             title, status, created_at, last_activity_at, parent_session_id,
             parent_message_id)
           values (?, ?, ?, ?, 'chat', 't', 'done', 0, 0, ?, ?)`,
        )
        .run(
          `bad-${parent}-${message}`,
          chat.projectId,
          chat.memberId,
          chat.agentId,
          parent,
          message,
        );
    expect(() => insert(root, null)).toThrow(/CHECK/);
    expect(() => insert(null, answerOf(chat, root))).toThrow(/CHECK/);
    expect(() => insert("nope", answerOf(chat, root))).toThrow(/FOREIGN/);
    expect(() => insert(root, "nope")).toThrow(/FOREIGN/);
    expect(() =>
      chat.app.sessions.create({
        projectId: chat.projectId,
        ownerId: chat.memberId,
        agentId: chat.agentId,
        origin: "automation",
        automationId: "a",
        parent: { sessionId: root, messageId: answerOf(chat, root) },
        title: "t",
        now: 0,
      }),
    ).toThrow("a child session has no automation");
  });
});

describe("the child mark on sends", () => {
  test("is set exactly on a child's sends, and refused otherwise", async () => {
    const chat = await chatApp();
    const root = await doneChat(chat);
    const child = addChild(chat, root);
    const send = (sessionId: string, child?: boolean) =>
      chat.app.sessions.createSend({
        sessionId,
        userId: chat.memberId,
        agentId: chat.agentId,
        providerId: chat.providerId,
        model: "m",
        firstMessageId: "x",
        now: chat.app.now.value,
        ...(child === undefined ? {} : { child }),
      });
    const mark = (id: string) =>
      chat.app.db.query("select child from sends where id = ?").get(id);
    expect(() => send(child)).toThrow(
      "a send is a child's exactly when its session is",
    );
    expect(() => send(root, true)).toThrow(
      "a send is a child's exactly when its session is",
    );
    expect(mark(send(child, true).id)).toEqual({ child: 1 });
    expect(mark(send(root).id)).toEqual({ child: 0 });
  });
});

describe("access", () => {
  test("every session route answers a child as a missing chat", async () => {
    const chat = await chatApp();
    const root = await doneChat(chat);
    const child = addChild(chat, root);
    const tool = `${child}-tool`;
    const calls: [string, string, unknown?][] = [
      ["GET", `/api/sessions/${child}`],
      ["GET", `/api/sessions/${child}/markdown?tz=UTC`],
      ["GET", `/api/sessions/${child}/messages/${tool}/result`],
      ["GET", `/api/sessions/${child}/messages/${tool}/files/0`],
      ["GET", `/api/sessions/${child}/messages/${tool}/calls/0/visual`],
      ["POST", `/api/sessions/${child}/messages`, { message: "more" }],
      ["POST", `/api/sessions/${child}/regenerate`, {}],
      ["POST", `/api/sessions/${child}/compact`],
      ["POST", `/api/sessions/${child}/stop`],
      [
        "POST",
        `/api/sessions/${child}/fork`,
        { messageId: tool, agentId: chat.agentId },
      ],
      ["PATCH", `/api/sessions/${child}`, { title: "renamed" }],
      ["POST", `/api/sessions/${child}/archive`],
      ["DELETE", `/api/sessions/${child}`],
      ["PATCH", `/api/sessions/${child}/queued/q`, { content: "x" }],
      ["DELETE", `/api/sessions/${child}/queued/q`],
    ];
    for (const client of [chat.member, chat.admin]) {
      for (const [method, path, body] of calls) {
        const res = await client.call(method, path, { body });
        expect([method, path, res.status]).toEqual([method, path, 404]);
        expect(await res.json()).toEqual({ error: "no such chat" });
      }
    }
    expect(left(chat, child).sessions).toBe(1);
    expect(chat.app.sessions.byId(child)!.title).toBe("a task");
    // the root still opens
    const res = await chat.member.call("GET", `/api/sessions/${root}`);
    expect(res.status).toBe(200);
  });

  test("a watch of a child is refused, its root's taken", async () => {
    const chat = await chatApp();
    const root = await doneChat(chat);
    const child = addChild(chat, root);
    const conn = await watcher(chat);
    watch(chat, conn, child);
    expect(conn.data.watching).toBeNull();
    expect(frames(conn, "watched")).toEqual([]);
    watch(chat, conn, root);
    expect(conn.data.watching).toBe(root);
    expect(frames(conn, "watched").map((f) => f.sessionId)).toEqual([root]);
  });
});

describe("lists and counts", () => {
  test("the feed, its search and the project's count show the root alone", async () => {
    const chat = await chatApp();
    const root = await doneChat(chat, "hello");
    addChild(chat, root);
    const ids = async (query: string) => {
      const res = await chat.member.call("GET", `/api/sessions?${query}`);
      expect(res.status).toBe(200);
      const body: SessionsResponse = await res.json();
      return body.rows.map((row) => row.session.id);
    };
    expect(await ids("")).toEqual([root]);
    expect(await ids("origin=chat")).toEqual([root]);
    expect(await ids("q=a%20task")).toEqual([]);
    expect(await ids("origin=chat&q=task")).toEqual([]);
    expect(await ids(`project=${chat.projectId}`)).toEqual([root]);
    expect(chat.app.sessions.count(chat.projectId)).toBe(1);
  });

  test("a running child counts no running chat of its own", async () => {
    const chat = await chatApp();
    const root = await doneChat(chat);
    addChild(chat, root, { status: "running" });
    expect(chat.app.sessions.running(chat.projectId)).toBe(false);
    const impact = await chat.admin.call(
      "GET",
      `/api/agents/${chat.agentId}/impact`,
    );
    expect(await impact.json()).toMatchObject({ chats: 1, running: 0 });
    const ids = await chat.member.call("GET", "/api/sessions");
    const body: SessionsResponse = await ids.json();
    expect(body.rows.map((row) => row.session.id)).toEqual([root]);
  });

  test("turns count roots, tokens and cost count every round", async () => {
    const chat = await chatApp();
    const root = await doneChat(chat);
    const since = chat.app.now.value - DAY_MS;
    const until = chat.app.now.value + DAY_MS;
    const before = chat.app.usage.total(
      { projectId: chat.projectId },
      since,
      until,
    );
    const week = chat.app.usage.week([chat.projectId], since, until);
    addChild(chat, root);
    const after = chat.app.usage.total(
      { projectId: chat.projectId },
      since,
      until,
    );
    expect(after.sends).toBe(before.sends);
    expect(after.tokens).toBe(before.tokens + 1100);
    expect(after.cost).toBe((before.cost ?? 0) + 0.5);
    expect(chat.app.usage.week([chat.projectId], since, until)).toEqual({
      ...week,
      promptTokens: week.promptTokens + 1000,
      completionTokens: week.completionTokens + 100,
    });
    const agent = chat.app.usage.total({ agentId: chat.agentId }, since, until);
    expect(agent.sends).toBe(1);
    const days = chat.app.usage.days([chat.projectId], [since], until);
    expect(days.total).toEqual({ sends: 1, tokens: after.tokens });
    const agentDays = chat.app.usage.agentDays(chat.agentId, [since], until);
    expect(agentDays.total).toEqual({ sends: 1, tokens: after.tokens });
  });

  test("Overview reads root sends for turns and every round for tokens", async () => {
    const chat = await chatApp();
    const root = await doneChat(chat);
    const input = {
      now: chat.app.now.value,
      since: chat.app.now.value - DAY_MS,
      until: chat.app.now.value + DAY_MS,
    };
    const before = month(chat.app.db, input);
    addChild(chat, root);
    const after = month(chat.app.db, input);
    const sum = (rows: { turns: number }[]) =>
      rows.reduce((n, row) => n + row.turns, 0);
    expect(sum(after.sends)).toBe(sum(before.sends));
    expect(sum(after.sends)).toBe(1);
    expect(after.ended).toEqual(before.ended);
    expect(after.actives).toEqual(before.actives);
    const rounds = (rows: { rounds: number }[]) =>
      rows.reduce((n, row) => n + row.rounds, 0);
    expect(rounds(after.usage)).toBe(rounds(before.usage) + 1);
    for (const key of ["agents", "projects"] as const) {
      const was = before.by[key].find((row) => row.turns > 0)!;
      const now = after.by[key].find((row) => row.key === was.key)!;
      expect(now.turns).toBe(was.turns);
      expect(now.tokens).toBe(was.tokens + 1100);
    }
    const ranged = range(chat.app.db, input);
    expect(sum(ranged.sends)).toBe(1);
  });

  test("activity reads roots: a user's days and an agent's last send", async () => {
    const chat = await chatApp();
    const root = await doneChat(chat);
    const since = chat.app.now.value - DAY_MS;
    const until = chat.app.now.value + DAY_MS;
    const days = personDays(chat.app.db, chat.memberId, [since], until);
    const last = agentActivity(chat.app.db);
    // a child starts after its root's send; a running one runs only
    // under its root's, which says running itself
    addChild(chat, root);
    expect(personDays(chat.app.db, chat.memberId, [since], until)).toEqual(
      days,
    );
    expect(agentActivity(chat.app.db)).toEqual(last);
    expect(last).toEqual([
      { agentId: chat.agentId, lastAt: expect.any(Number), running: false },
    ]);
  });
});

describe("storage", () => {
  test("a child's bytes fold into its root, which alone is a chat", async () => {
    const chat = await chatApp();
    const root = await doneChat(chat);
    const before = scan(chat.app.db, { now: chat.app.now.value, since: 0 });
    const own = before.sessions.find((s) => s.id === root)!;
    const child = addChild(chat, root);
    const after = scan(chat.app.db, { now: chat.app.now.value, since: 0 });
    expect(after.sessions.map((s) => s.id)).toEqual([root]);
    const folded = after.sessions[0]!;
    expect(folded.messages).toBe(own.messages);
    expect(folded.messageBytes).toBeGreaterThan(own.messageBytes + BIG.length);
    expect(after.sessions.some((s) => s.id === child)).toBe(false);
  });
});

describe("archive, packing and deletion", () => {
  test("archiving the root archives and packs its child with it", async () => {
    const chat = await chatApp();
    const root = await doneChat(chat);
    const child = addChild(chat, root);
    const res = await chat.member.call("POST", `/api/sessions/${root}/archive`);
    expect(res.status).toBe(204);
    const row = chat.app.sessions.byId(child)!;
    expect(row.archived).toEqual({
      at: chat.app.now.value,
      reason: "manual",
    });
    expect(
      count(
        chat,
        "select count(*) as n from messages where session_id = ? and packed is not null",
        child,
      ),
    ).toBe(1);
  });

  test("the sweep never takes a child alone and carries it with its root", async () => {
    const chat = await chatApp();
    const root = await doneChat(chat);
    const child = addChild(chat, root);
    // a child idle past the cut while its root is fresh stays
    chat.app.db
      .query("update sessions set last_activity_at = ? where id = ?")
      .run(chat.app.now.value - 31 * DAY_MS, child);
    chat.app.sweep();
    expect(chat.app.sessions.byId(child)!.archived).toBeNull();
    expect(chat.app.sessions.byId(root)!.archived).toBeNull();
    // the root idle archives both; the child's large row packs with it
    chat.app.db
      .query("update sessions set last_activity_at = ? where id = ?")
      .run(chat.app.now.value - 31 * DAY_MS, root);
    chat.app.sweep();
    expect(chat.app.sessions.byId(root)!.archived?.reason).toBe("idle");
    expect(chat.app.sessions.byId(child)!.archived?.reason).toBe("idle");
    expect(
      count(
        chat,
        "select count(*) as n from messages where session_id = ? and packed is not null",
        child,
      ),
    ).toBe(1);
    // past the keep, the root's delete takes the child
    chat.app.db
      .query("update sessions set archived_at = 1 where id in (?, ?)")
      .run(root, child);
    chat.app.now.value += 400 * DAY_MS;
    chat.app.sweep();
    expect(chat.app.sessions.byId(root)).toBeNull();
    expect(left(chat, child).sessions).toBe(0);
  });

  test("an ended root whose child alone holds a large result is packed", async () => {
    const chat = await chatApp();
    const root = await doneChat(chat);
    const child = addChild(chat, root);
    chat.app.db
      .query(
        `update sessions set archived_at = ?, archived_reason = 'agent'
         where id in (?, ?)`,
      )
      .run(chat.app.now.value, root, child);
    chat.app.sweep();
    expect(
      count(
        chat,
        "select count(*) as n from messages where session_id = ? and packed is not null",
        child,
      ),
    ).toBe(1);
  });

  test("an agent's delete archives its chats with their children", async () => {
    const chat = await chatApp();
    const root = await doneChat(chat);
    const child = addChild(chat, root);
    const res = await chat.admin.call("DELETE", `/api/agents/${chat.agentId}`);
    expect(res.status).toBe(200);
    expect(chat.app.sessions.byId(root)!.archived?.reason).toBe("agent");
    expect(chat.app.sessions.byId(child)!.archived?.reason).toBe("agent");
  });

  test("a child's kept files are judged by its root", async () => {
    const chat = await chatApp();
    const root = await doneChat(chat);
    const child = addChild(chat, root);
    const still = (id: string) =>
      chat.app.db
        .query<{ id: string }, [number, number, string]>(KEPT_STILL)
        .get(0, chat.app.now.value, id);
    // the root chat is not archived, so neither is due for packing
    expect(still(child)).toBeNull();
    chat.app.db
      .query(
        `update sessions set archived_at = ?, archived_reason = 'manual'
         where id = ?`,
      )
      .run(chat.app.now.value, root);
    expect(still(child)).toEqual({ id: child });
  });
});

describe("a run as the root", () => {
  test("its child is packed with it, folded into its storage and goes with its retention", async () => {
    const chat = await chatApp();
    const { runId } = await doneRun(chat, 1);
    const own = scan(chat.app.db, { now: chat.app.now.value, since: 0 })
      .sessions[0]!;
    const child = addChild(chat, runId);
    expect(chat.app.sessions.byId(child)).toMatchObject({
      origin: "automation",
      automationId: null,
    });
    chat.app.sweep();
    expect(packed(chat, child)).toBe(1);
    const sums = scan(chat.app.db, { now: chat.app.now.value, since: 0 });
    expect(sums.sessions.map((row) => row.id)).toEqual([runId]);
    expect(sums.sessions[0]!.messageBytes).toBeGreaterThan(own.messageBytes);
    // a run past its task's retention takes its child
    ago(chat, runId, 2);
    expect(chat.app.automationScheduler.sweep()).toBe(1);
    expect(chat.app.sessions.byId(runId)).toBeNull();
    expect(left(chat, child).sessions).toBe(0);
  });

  test("the orphan runs step never takes a run's child alone", async () => {
    const chat = await chatApp();
    const { automationId, runId } = await doneRun(chat);
    const child = addChild(chat, runId);
    const res = await chat.member.call(
      "DELETE",
      `/api/automations/${automationId}`,
    );
    expect(res.status).toBe(204);
    // the child past the cut, its orphaned run fresh
    ago(chat, child, 400);
    chat.app.sweep();
    expect(left(chat, child).sessions).toBe(1);
    // the run past the cut takes it
    ago(chat, runId, 400);
    chat.app.sweep();
    expect(chat.app.sessions.byId(runId)).toBeNull();
    expect(left(chat, child).sessions).toBe(0);
  });
});

describe("restart repair", () => {
  test.serial("ends a running child and publishes nothing for it", async () => {
    const chat = await chatApp();
    const root = await doneChat(chat);
    const child = addChild(chat, root, { status: "running" });
    const events: BusEvent[] = [];
    const off = subscribe((event) => events.push(event), silent);
    try {
      chat.app.automationScheduler.dispose();
      const restarted = await testApp({
        db: chat.app.db,
        fetcher: chat.scripted.fetcher,
      });
      expect(restarted.repaired).toBe(0);
      expect(restarted.sessions.byId(child)!.status).toBe("failed");
      expect(
        chat.app.db
          .query("select status, cause from sends where session_id = ?")
          .get(child),
      ).toEqual({ status: "failed", cause: "restart" });
      expect(
        chat.app.db
          .query("select status from messages where id = ?")
          .get(`${child}-tool`),
      ).toEqual({ status: "stopped" });
      expect(
        events.filter(
          (event) =>
            event.type === "session.changed" && event.data.session.id === child,
        ),
      ).toEqual([]);
      await restarted.shutdown();
    } finally {
      off();
    }
  });
});
