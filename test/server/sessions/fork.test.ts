// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { BadRequest, NotFound } from "../../../src/server/lib/errors.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { SUMMARY_LEAD } from "../../../src/server/runner/context.ts";
import { forkPoint } from "../../../src/server/sessions/fork.ts";
import { MAX_SMALL_BODY } from "../../../src/server/sessions/parse.ts";
import type {
  RawMessage,
  RawSend,
  RawSession,
} from "../../../src/server/sessions/rows.ts";
import type { ForkSessionResponse } from "../../../src/shared/api/sessions.ts";
import type {
  Message,
  SessionDetail,
} from "../../../src/shared/contracts/session.ts";
import {
  forkFixtures,
  forkRow,
  forkSends,
} from "../../fixtures/sessions/fork.ts";
import { collectLogs, type TestClient } from "../../helpers/app.ts";
import {
  createAutomation,
  settleRun as settle,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  NO_TOOLS,
  type Script,
  startChat,
  waitScript,
} from "../../helpers/chat.ts";

type StoredMessage = Omit<RawMessage, "prompt_tokens"> & {
  reasoning_details: string | null;
};
type StoredSend = Omit<RawSend, "tokens"> & { mcp: string | null };

const timeCall = {
  id: "time-1",
  name: "datetime",
  arguments: '{"timezone":"UTC"}',
};

function storedMessages(chat: ChatApp, sessionId: string): StoredMessage[] {
  return chat.app.db
    .query<StoredMessage, [string]>(
      "select * from messages where session_id = ? order by seq",
    )
    .all(sessionId);
}

function storedSends(chat: ChatApp, sessionId: string): StoredSend[] {
  return chat.app.db
    .query<StoredSend, [string]>(
      "select * from sends where session_id = ? order by started_at, rowid",
    )
    .all(sessionId);
}

async function finish(chat: ChatApp, sessionId: string, script: Script) {
  script.reply("the original answer");
  await settle(chat, sessionId);
}

async function fork(
  chat: ChatApp,
  sessionId: string,
  messageId: string,
  agentId = chat.agentId,
  client = chat.member,
): Promise<ForkSessionResponse> {
  const response = await client.call(
    "POST",
    `/api/sessions/${sessionId}/fork`,
    { body: { messageId, agentId } },
  );
  expect(response.status).toBe(201);
  return response.json();
}

async function detail(
  client: TestClient,
  sessionId: string,
): Promise<SessionDetail> {
  const response = await client.call("GET", `/api/sessions/${sessionId}`);
  expect(response.status).toBe(200);
  return response.json();
}

async function teamProject(chat: ChatApp): Promise<string> {
  const response = await chat.admin.call("POST", "/api/projects", {
    body: { name: "fork-team", description: "" },
  });
  expect(response.status).toBe(201);
  const { project } = await response.json();
  expect(
    (
      await chat.admin.call("POST", `/api/projects/${project.id}/members`, {
        body: { userId: chat.memberId },
      })
    ).status,
  ).toBe(201);
  return project.id;
}

function expectCopy(
  chat: ChatApp,
  copied: SessionDetail,
  sourceRows: StoredMessage[],
  sourceSends: StoredSend[],
) {
  const rows = storedMessages(chat, copied.session.id);
  const sends = storedSends(chat, copied.session.id);
  expect(rows).toHaveLength(sourceRows.length);
  expect(sends).toHaveLength(sourceSends.length);
  const messageIds = new Map(sourceRows.map((row, i) => [row.id, rows[i]!.id]));
  const sendIds = new Map(
    sourceSends.map((send, i) => [send.id, sends[i]!.id]),
  );
  const sourceIds = new Set([
    ...sourceRows.map((row) => row.id),
    ...sourceSends.map((send) => send.id),
    sourceRows[0]?.session_id,
  ]);
  const newIds = [
    copied.session.id,
    ...rows.map((row) => row.id),
    ...sends.map((send) => send.id),
  ];
  expect(new Set(newIds).size).toBe(newIds.length);
  for (const id of newIds) expect(sourceIds.has(id)).toBeFalse();
  expect(rows).toEqual(
    sourceRows.map((row) => ({
      ...row,
      id: messageIds.get(row.id)!,
      session_id: copied.session.id,
      send_id: sendIds.get(row.send_id)!,
    })),
  );
  expect(sends).toEqual(
    sourceSends.map((send) => {
      const kept = sourceRows.filter((row) => row.send_id === send.id);
      return {
        ...send,
        id: sendIds.get(send.id)!,
        session_id: copied.session.id,
        first_message_id: messageIds.get(send.first_message_id)!,
        rounds: Math.max(...kept.map((row) => row.round)),
        tool_calls: kept.filter((row) => row.kind === "tool").length,
        mcp: null,
        memory_round: null,
        memory_error: null,
        memory_skipped: null,
      };
    }),
  );
  expect(copied.session.usage).toBeNull();
  expect(
    chat.app.db
      .query<{ n: number }, [string]>(
        "select count(*) as n from usage where session_id = ?",
      )
      .get(copied.session.id),
  ).toEqual({ n: 0 });
  for (const send of sends) {
    expect(chat.app.sessions.send(send.id)?.tokens).toBe(0);
  }
  expect(chat.app.db.query("pragma foreign_key_check").all()).toEqual([]);
}

describe("forkPoint", () => {
  for (const fixture of forkFixtures) {
    test(fixture.name, () => {
      const rows = fixture.rows.map(forkRow);
      const sends = structuredClone(fixture.sends ?? forkSends);
      const before = structuredClone({ rows, sends });
      if (fixture.error) {
        const fail = () => forkPoint(rows, sends, fixture.target);
        expect(fail).toThrow(
          fixture.error.status === 404 ? NotFound : BadRequest,
        );
        expect(fail).toThrow(fixture.error.message);
      } else {
        const result = forkPoint(rows, sends, fixture.target);
        expect(result).toEqual({
          rows: fixture.ids!.map((id) => rows.find((row) => row.id === id)!),
          draft: fixture.draft ?? null,
        });
      }
      expect({ rows, sends }).toEqual(before);
    });
  }
});

describe("POST /api/sessions/:id/fork", () => {
  test("copies exact stored rows and sends, including a following compact summary", async () => {
    const chat = await chatApp();
    try {
      const picked = await chat.makeAgent({
        name: "reviewer",
        model: NO_TOOLS,
      });
      const source = await startChat(chat, "what time is it");
      source.script.reasoning("checking the clock");
      source.script.content("Let me check.");
      source.script.toolRound([timeCall]);
      source.script.end();
      await finish(chat, source.sessionId, await waitScript(chat.scripted, 2));
      const store = chat.app.sessions;
      const answer = store
        .messages(source.sessionId)
        .find((row) => row.slot === "answer")!;
      chat.app.now.value += 20;
      expect(
        (
          await chat.member.call(
            "POST",
            `/api/sessions/${source.sessionId}/compact`,
          )
        ).status,
      ).toBe(200);
      const compact = await waitScript(chat.scripted, 3);
      compact.reply("The compact summary.");
      await settle(chat, source.sessionId);
      const kept = store.messages(source.sessionId);
      expect(kept.map((row) => row.kind)).toEqual([
        "user",
        "reply",
        "tool",
        "reply",
        "summary",
      ]);

      const work = kept.find((row) => row.slot === "work")!;
      const result = kept.find((row) => row.kind === "tool")!;
      const calls = JSON.stringify([
        { ...timeCall, signature: "opaque-source-model-signature" },
      ]);
      const reasoning =
        '[ { "type": "reasoning.encrypted", "data": "opaque" } ]';
      chat.app.db
        .query(
          `update messages set tool_calls = ?, reasoning_details = ?,
             reasoning = ?, ttft_ms = 23, thinking_ms = 41 where id = ?`,
        )
        .run(calls, reasoning, "stored reasoning\r\nkept as written", work.id);
      chat.app.db
        .query(
          "update messages set content = ?, error = ?, status = 'failed' where id = ?",
        )
        .run("clock failed: résumé 🕰️", "clock error details", result.id);
      chat.app.db
        .query("insert into mcp_digests (key, body) values (?, ?)")
        .run("fork-digest", "{}");
      chat.app.db
        .query(
          `update sends set mcp = 'fork-digest', memory_round = 40,
             memory_error = 'old phase error', memory_skipped = 2,
             rounds = 99, tool_calls = 88, status = 'stopped',
             cause = 'stop', error = 'saved send error' where id = ?`,
        )
        .run(answer.sendId);

      const sourceRows = storedMessages(chat, source.sessionId);
      const sourceSends = storedSends(chat, source.sessionId);
      chat.app.now.value += 100;
      expect(
        (
          await chat.member.call(
            "POST",
            `/api/sessions/${source.sessionId}/messages`,
            { body: { message: "This later turn must not be copied." } },
          )
        ).status,
      ).toBe(201);
      await finish(chat, source.sessionId, await waitScript(chat.scripted, 4));
      const before = {
        session: store.byId(source.sessionId),
        messages: storedMessages(chat, source.sessionId),
        sends: storedSends(chat, source.sessionId),
      };
      chat.app.now.value += 123;
      const copied = await fork(chat, source.sessionId, answer.id, picked);
      expectCopy(chat, copied, sourceRows, sourceSends);
      expect(copied.session).toEqual({
        id: copied.session.id,
        projectId: chat.projectId,
        ownerId: chat.memberId,
        agentId: picked,
        origin: "chat",
        automationId: null,
        runSource: null,
        forkedFromId: source.sessionId,
        title: "Fork of what time is it",
        status: "done",
        disabledCapabilities: [],
        revision: 0,
        createdAt: chat.app.now.value,
        lastActivityAt: chat.app.now.value,
        usage: null,
      });
      const rawSession = chat.app.db
        .query<RawSession, [string]>("select * from sessions where id = ?")
        .get(copied.session.id);
      expect(rawSession).toEqual({
        id: copied.session.id,
        project_id: chat.projectId,
        owner_id: chat.memberId,
        agent_id: picked,
        origin: "chat",
        automation_id: null,
        run_source: null,
        forked_from_session_id: source.sessionId,
        forked_from_message_id: answer.id,
        title: "Fork of what time is it",
        status: "done",
        disabled_capabilities: "[]",
        revision: 0,
        created_at: chat.app.now.value,
        last_activity_at: chat.app.now.value,
      });
      expect(copied.live).toBeNull();
      expect(copied.send?.kind).toBe("compact");
      expect(copied.send?.tokens).toBe(0);
      expect(
        copied.messages.every((row) => row.promptTokens === null),
      ).toBeTrue();
      expect(copied.messages.find((row) => row.kind === "tool")).toMatchObject({
        content: "",
        error: null,
        resultBytes: Buffer.byteLength("clock failed: résumé 🕰️"),
        status: "failed",
      });
      expect(
        copied.messages.find((row) => row.slot === "work")?.toolCalls,
      ).toEqual([{ ...timeCall, signature: "opaque-source-model-signature" }]);
      expect(copied).toEqual({
        ...(await detail(chat.member, copied.session.id)),
        draftUploads: [],
      });
      expect({
        session: store.byId(source.sessionId),
        messages: storedMessages(chat, source.sessionId),
        sends: storedSends(chat, source.sessionId),
      }).toEqual(before);
      expect(chat.scripted.scripts).toHaveLength(4);
      expect(chat.app.runner.registry.get(copied.session.id)).toBeNull();
    } finally {
      await chat.app.shutdown();
    }
  });

  test("keeps an automatic summary and starts the fork's next send from it", async () => {
    const chat = await chatApp();
    try {
      const source = await startChat(chat, "the old question");
      source.script.content("the old answer");
      source.script.finish();
      source.script.usage({ prompt: 1_040_000, completion: 10 });
      source.script.end();
      const summary = await waitScript(chat.scripted, 2);
      summary.content("## Goal\n\n- Continue");
      summary.finish();
      summary.usage({ prompt: 41_000, completion: 200 });
      summary.end();
      await settle(chat, source.sessionId);
      const rows = chat.app.sessions.messages(source.sessionId);
      expect(rows.map((row) => row.kind)).toEqual(["user", "reply", "summary"]);
      expect(rows[2]?.promptTokens).toBe(41_000);
      const copied = await fork(chat, source.sessionId, rows[1]!.id);
      expectCopy(
        chat,
        copied,
        storedMessages(chat, source.sessionId),
        storedSends(chat, source.sessionId),
      );
      expect(copied.messages[2]).toMatchObject({
        kind: "summary",
        promptTokens: null,
        content: "## Goal\n\n- Continue",
      });
      expect(copied.send).toMatchObject({ kind: "chat", rounds: 2, tokens: 0 });
      expect(
        (
          await chat.member.call(
            "POST",
            `/api/sessions/${copied.session.id}/messages`,
            { body: { message: "the new question" } },
          )
        ).status,
      ).toBe(201);
      const next = await waitScript(chat.scripted, 3);
      expect(next.body.messages).toEqual([
        { role: "system", content: expect.any(String) },
        { role: "user", content: `${SUMMARY_LEAD}\n\n## Goal\n\n- Continue` },
        { role: "user", content: "the new question", name: "casey" },
      ]);
      await finish(chat, copied.session.id, next);
      expect(chat.app.sessions.send(copied.send!.id)?.tokens).toBe(0);
      expect(chat.app.sessions.lastSend(copied.session.id)?.tokens).toBe(15);
      expect(chat.app.sessions.byId(copied.session.id)?.usage).toMatchObject({
        promptTokens: 10,
        completionTokens: 5,
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  test.serial(
    "publishes one off-wire envelope after every copied row commits",
    async () => {
      const chat = await chatApp();
      let off = () => {};
      try {
        const source = await startChat(chat);
        source.script.toolRound([timeCall]);
        source.script.end();
        await finish(
          chat,
          source.sessionId,
          await waitScript(chat.scripted, 2),
        );
        const sourceRows = chat.app.sessions.messages(source.sessionId);
        const answer = sourceRows.find((row) => row.slot === "answer")!;
        const observed: {
          event: BusEvent;
          inTransaction: boolean;
          sessionExists: boolean;
          rows: Message[];
        }[] = [];
        off = subscribe((event) => {
          if (event.type !== "session.changed") return;
          observed.push({
            event,
            inTransaction: chat.app.db.inTransaction,
            sessionExists:
              chat.app.sessions.byId(event.data.session.id) !== null,
            rows: chat.app.sessions.messages(event.data.session.id),
          });
        }, silent);
        const copied = await fork(chat, source.sessionId, answer.id);
        expect(observed).toHaveLength(1);
        const observation = observed[0]!;
        expect(observation.inTransaction).toBeFalse();
        expect(observation.sessionExists).toBeTrue();
        expect(observation.rows).toHaveLength(sourceRows.length);
        expect(observation.event).toEqual({
          type: "session.changed",
          data: {
            projectId: chat.projectId,
            session: copied.session,
            messages: copied.messages,
            send: null,
          },
        });
        const tool = copied.messages.find((row) => row.kind === "tool")!;
        const stored = observation.rows.find((row) => row.id === tool.id)!;
        expect(stored.content).not.toBe("");
        expect(tool).toEqual({
          ...stored,
          content: "",
          error: null,
          resultBytes: Buffer.byteLength(stored.content),
        });
      } finally {
        off();
        await chat.app.shutdown();
      }
    },
  );

  test.serial(
    "rolls back sessions, sends and messages and emits nothing on a copy failure",
    async () => {
      const logs = collectLogs();
      const chat = await chatApp({ logFactory: logs.logFactory });
      let off = () => {};
      try {
        const source = await startChat(chat);
        await finish(chat, source.sessionId, source.script);
        const answer = chat.app.sessions.messages(source.sessionId)[1]!;
        const before = {
          sessions: chat.app.db.query("select * from sessions").all(),
          sends: chat.app.db.query("select * from sends").all(),
          messages: chat.app.db.query("select * from messages").all(),
          usage: chat.app.db.query("select * from usage").all(),
        };
        chat.app.db.exec(`
        create trigger fail_fork_copy before insert on messages
        when new.seq = 2
        begin
          select raise(abort, 'injected fork copy failure');
        end;
      `);
        const events: BusEvent[] = [];
        off = subscribe((event) => events.push(event), silent);
        const response = await chat.member.call(
          "POST",
          `/api/sessions/${source.sessionId}/fork`,
          { body: { messageId: answer.id, agentId: chat.agentId } },
        );
        expect(response.status).toBe(500);
        expect(
          logs.events.findLast((event) => event.level === "error"),
        ).toMatchObject({
          area: "router",
          msg: "request",
          fields: {
            route: "/api/sessions/:id/fork",
            status: 500,
            error: "injected fork copy failure",
          },
        });
        expect(events).toEqual([]);
        expect(chat.app.db.inTransaction).toBeFalse();
        expect({
          sessions: chat.app.db.query("select * from sessions").all(),
          sends: chat.app.db.query("select * from sends").all(),
          messages: chat.app.db.query("select * from messages").all(),
          usage: chat.app.db.query("select * from usage").all(),
        }).toEqual(before);
        chat.app.db.exec("drop trigger fail_fork_copy");
        const copied = await fork(chat, source.sessionId, answer.id);
        expect(copied.messages).toHaveLength(2);
        expect(events).toHaveLength(1);
      } finally {
        off();
        await chat.app.shutdown();
      }
    },
  );

  test("forks a first user message into an empty chat without sending its draft", async () => {
    const chat = await chatApp();
    try {
      const source = await startChat(chat, "  edit this\nbefore sending  ");
      const user = chat.app.sessions.messages(source.sessionId)[0]!;
      const copied = await fork(chat, source.sessionId, user.id);
      expect(copied.messages).toEqual([]);
      expect(storedSends(chat, copied.session.id)).toEqual([]);
      expect(copied.send).toBeNull();
      expect(copied.live).toBeNull();
      expect(copied.session.status).toBe("done");
      expect(copied.session.revision).toBe(0);
      expect(copied.session.usage).toBeNull();
      expect(copied.forkedFrom).toEqual({
        id: source.sessionId,
        title: "edit this",
        origin: "chat",
      });
      expect(chat.scripted.scripts).toHaveLength(1);
      await finish(chat, source.sessionId, source.script);
      expect(
        (
          await chat.member.call(
            "POST",
            `/api/sessions/${copied.session.id}/messages`,
            { body: { message: "edited draft" } },
          )
        ).status,
      ).toBe(201);
      const next = await waitScript(chat.scripted, 2);
      expect(next.body.messages).toEqual([
        { role: "system", content: expect.any(String) },
        { role: "user", content: "edited draft", name: "casey" },
      ]);
      await finish(chat, copied.session.id, next);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a running source can be forked at an older answer or the current user", async () => {
    const chat = await chatApp();
    try {
      const source = await startChat(chat);
      await finish(chat, source.sessionId, source.script);
      const keptRows = storedMessages(chat, source.sessionId);
      const keptSends = storedSends(chat, source.sessionId);
      const answer = chat.app.sessions.messages(source.sessionId)[1]!;
      expect(
        (
          await chat.member.call(
            "POST",
            `/api/sessions/${source.sessionId}/messages`,
            { body: { message: "still running" } },
          )
        ).status,
      ).toBe(201);
      const running = await waitScript(chat.scripted, 2);
      running.content("partial answer");
      const activeRows = chat.app.sessions.messages(source.sessionId);
      const currentUser = activeRows.find(
        (row) => row.kind === "user" && row.content === "still running",
      )!;
      const byAnswer = await fork(chat, source.sessionId, answer.id);
      const byUser = await fork(chat, source.sessionId, currentUser.id);
      for (const copied of [byAnswer, byUser]) {
        expectCopy(chat, copied, keptRows, keptSends);
        expect(copied.messages.map((row) => row.content)).toEqual([
          "hello",
          "the original answer",
        ]);
        expect(copied.session.status).toBe("done");
      }
      expect(chat.app.sessions.byId(source.sessionId)?.status).toBe("running");
      expect(running.aborted).toBeFalse();
      expect(chat.scripted.scripts).toHaveLength(2);
      await finish(chat, source.sessionId, running);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("copies a stopped answer without carrying the source's stopped state", async () => {
    const chat = await chatApp();
    try {
      const source = await startChat(chat);
      expect(
        (
          await chat.member.call(
            "POST",
            `/api/sessions/${source.sessionId}/stop`,
          )
        ).status,
      ).toBe(200);
      await settle(chat, source.sessionId);
      const answer = chat.app.sessions.messages(source.sessionId)[1]!;
      expect(answer).toMatchObject({ slot: "answer", status: "stopped" });
      const copied = await fork(chat, source.sessionId, answer.id);
      expectCopy(
        chat,
        copied,
        storedMessages(chat, source.sessionId),
        storedSends(chat, source.sessionId),
      );
      expect(copied.session.status).toBe("done");
      expect(copied.messages[1]?.status).toBe("stopped");
      expect(copied.send).toMatchObject({ status: "stopped", cause: "stop" });
      expect(chat.scripted.scripts).toHaveLength(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("keeps provenance ids while reading the source's latest title or deletion", async () => {
    const chat = await chatApp();
    try {
      const source = await startChat(chat, "source title");
      await finish(chat, source.sessionId, source.script);
      const answer = chat.app.sessions.messages(source.sessionId)[1]!;
      expect(
        (await detail(chat.member, source.sessionId)).forkedFrom,
      ).toBeNull();
      const copied = await fork(chat, source.sessionId, answer.id);
      expect(copied.forkedFrom).toEqual({
        id: source.sessionId,
        title: "source title",
        origin: "chat",
      });
      expect(
        (
          await chat.member.call("PATCH", `/api/sessions/${source.sessionId}`, {
            body: { title: "renamed source" },
          })
        ).status,
      ).toBe(200);
      expect((await detail(chat.member, copied.session.id)).forkedFrom).toEqual(
        {
          id: source.sessionId,
          title: "renamed source",
          origin: "chat",
        },
      );
      expect(
        (await chat.member.call("DELETE", `/api/sessions/${source.sessionId}`))
          .status,
      ).toBe(200);
      const after = await detail(chat.member, copied.session.id);
      expect(after.forkedFrom).toEqual({
        id: source.sessionId,
        title: null,
        origin: null,
      });
      expect(after.session.forkedFromId).toBe(source.sessionId);
      expect(after.session.title).toBe("Fork of source title");
      expect(chat.app.db.query("pragma foreign_key_check").all()).toEqual([]);
      const markdown = await chat.member.call(
        "GET",
        `/api/sessions/${copied.session.id}/markdown?tz=UTC`,
      );
      expect(markdown.status).toBe(200);
      const text = await markdown.text();
      expect(text).toContain("the original answer");
      expect(text).not.toContain("Forked");
      expect(text).not.toContain(source.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("hides other personal chats and messages from another session", async () => {
    const chat = await chatApp();
    try {
      const source = await startChat(chat);
      await finish(chat, source.sessionId, source.script);
      const other = await startChat(chat, "another chat");
      await finish(chat, other.sessionId, other.script);
      const answer = chat.app.sessions.messages(source.sessionId)[1]!;
      const foreign = chat.app.sessions.messages(other.sessionId)[1]!;
      for (const [client, sessionId, messageId, error] of [
        [chat.admin, source.sessionId, answer.id, "no such chat"],
        [chat.member, source.sessionId, foreign.id, "no such message"],
        [chat.member, source.sessionId, "000000000000", "no such message"],
        [chat.member, "000000000000", answer.id, "no such chat"],
      ] as const) {
        const response = await client.call(
          "POST",
          `/api/sessions/${sessionId}/fork`,
          { body: { messageId, agentId: chat.agentId } },
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error });
      }
      expect(chat.app.sessions.count(chat.projectId)).toBe(2);
      expect(chat.scripted.scripts).toHaveLength(2);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a team member forks another author's tools onto another agent and owns the result", async () => {
    const chat = await chatApp();
    try {
      const projectId = await teamProject(chat);
      const picked = await chat.makeAgent({
        name: "reviewer",
        model: NO_TOOLS,
      });
      const source = await startChat(
        chat,
        "admin question",
        chat.admin,
        projectId,
      );
      source.script.content("Checking.");
      source.script.toolRound([timeCall]);
      source.script.end();
      await finish(chat, source.sessionId, await waitScript(chat.scripted, 2));
      const sourceRows = chat.app.sessions.messages(source.sessionId);
      const answer = sourceRows.find((row) => row.slot === "answer")!;
      const tool = sourceRows.find((row) => row.kind === "tool")!;
      const copied = await fork(chat, source.sessionId, answer.id, picked);
      expect(copied.session.ownerId).toBe(chat.memberId);
      expect(copied.session.projectId).toBe(projectId);
      expect(copied.messages[0]?.userId).toBe(chat.adminId);
      expect(
        copied.messages
          .filter((row) => row.kind === "reply")
          .map((row) => row.agentId),
      ).toEqual([chat.agentId, chat.agentId]);
      expect(
        (
          await chat.member.call("PATCH", `/api/sessions/${source.sessionId}`, {
            body: { title: "not mine" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await chat.member.call(
            "PATCH",
            `/api/sessions/${copied.session.id}`,
            {
              body: { title: "my follow-up" },
            },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await chat.member.call(
            "POST",
            `/api/sessions/${copied.session.id}/messages`,
            { body: { message: "member follow-up" } },
          )
        ).status,
      ).toBe(201);
      const next = await waitScript(chat.scripted, 3);
      expect(next.body.model).toBe(NO_TOOLS);
      expect(next.body.tools).toBeUndefined();
      expect(next.body.messages).toEqual([
        { role: "system", content: expect.any(String) },
        { role: "user", content: "admin question", name: "admin" },
        {
          role: "assistant",
          content: "Checking.",
          tool_calls: [
            {
              id: timeCall.id,
              type: "function",
              function: {
                name: timeCall.name,
                arguments: timeCall.arguments,
              },
            },
          ],
        },
        { role: "tool", content: tool.content, tool_call_id: timeCall.id },
        { role: "assistant", content: "the original answer" },
        { role: "user", content: "member follow-up", name: "casey" },
      ]);
      await finish(chat, copied.session.id, next);
      const continued = await detail(chat.member, copied.session.id);
      expect(continued.messages.at(-2)?.userId).toBe(chat.memberId);
      expect(continued.messages.at(-1)?.agentId).toBe(picked);
      expect(continued.send).toMatchObject({
        agentId: picked,
        userId: chat.memberId,
        providerId: chat.providerId,
        model: NO_TOOLS,
      });
      expect(
        (await chat.admin.call("DELETE", `/api/sessions/${source.sessionId}`))
          .status,
      ).toBe(200);
      const deletion = await chat.admin.call(
        "DELETE",
        `/api/agents/${chat.agentId}`,
      );
      expect(deletion.status).toBe(409);
      expect(await deletion.json()).toEqual({ error: "a chat uses coder" });
      expect(
        (await chat.member.call("DELETE", `/api/sessions/${copied.session.id}`))
          .status,
      ).toBe(200);
      expect(
        (await chat.admin.call("DELETE", `/api/agents/${chat.agentId}`)).status,
      ).toBe(200);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a run fork keeps its outcome but never its memory phase or automation identity", async () => {
    const chat = await chatApp();
    try {
      const projectId = await teamProject(chat);
      const automation = await createAutomation(
        { ...chat, projectId },
        { ownMemory: true },
      );
      const source = await startRun(chat, automation.id);
      source.main.reply("The check passed.");
      const phase = await waitScript(chat.scripted, 2);
      phase.toolRound([
        {
          id: "remember",
          name: "memory_edit",
          arguments:
            '{"action":"set","topic":"Status","text":"Last check passed."}',
        },
      ]);
      phase.end();
      await settle(chat, source.sessionId);
      const before = await detail(chat.admin, source.sessionId);
      const sourceRows = storedMessages(chat, source.sessionId);
      const sourceSends = storedSends(chat, source.sessionId);
      expect(before.send?.memoryRound).toBe(2);
      expect(sourceRows.some((row) => row.round >= 2)).toBeTrue();
      const answer = before.messages.find((row) => row.slot === "answer")!;
      const copied = await fork(
        chat,
        source.sessionId,
        answer.id,
        chat.agentId,
        chat.admin,
      );
      expectCopy(
        chat,
        copied,
        sourceRows.filter((row) => row.round < 2),
        sourceSends,
      );
      expect(copied.session).toMatchObject({
        origin: "chat",
        automationId: null,
        runSource: null,
        ownerId: chat.adminId,
        projectId,
        title: `Fork of ${automation.name}`,
        status: "done",
      });
      expect(copied.forkedFrom).toEqual({
        id: source.sessionId,
        title: automation.name,
        origin: "automation",
      });
      expect(copied.messages.map((row) => row.content)).toEqual([
        "check the system",
        "The check passed.",
      ]);
      expect(copied.messages[0]?.userId).toBe(chat.memberId);
      expect(copied.send).toMatchObject({
        kind: "run",
        userId: chat.memberId,
        rounds: 1,
        toolCalls: 0,
        memoryRound: null,
        memoryError: null,
        memorySkipped: null,
      });
      const memoryRow = before.messages.find((row) => row.round === 2)!;
      const refused = await chat.admin.call(
        "POST",
        `/api/sessions/${source.sessionId}/fork`,
        { body: { messageId: memoryRow.id, agentId: chat.agentId } },
      );
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: "not a turn" });
      expect(await detail(chat.admin, source.sessionId)).toEqual(before);
      expect(chat.scripted.scripts).toHaveLength(2);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a source send still running is copied as finished, so repair leaves the fork alone", async () => {
    const chat = await chatApp();
    try {
      const source = await startChat(chat);
      await finish(chat, source.sessionId, source.script);
      const answer = chat.app.sessions
        .messages(source.sessionId)
        .find((m) => m.kind === "reply" && m.slot === "answer")!;
      // the answer's send runs on: its summary streams after the answer
      chat.app.db
        .query(
          "update sends set status = 'running', cause = null, finished_at = null where id = ?",
        )
        .run(answer.sendId);
      chat.app.db
        .query("update sessions set status = 'running' where id = ?")
        .run(source.sessionId);
      const copied = await fork(chat, source.sessionId, answer.id);
      const send = chat.app.db
        .query<
          { status: string; cause: string | null; finished_at: number | null },
          [string]
        >("select status, cause, finished_at from sends where session_id = ?")
        .get(copied.session.id)!;
      expect(send.status).toBe("done");
      expect(send.cause).toBe("finish");
      expect(send.finished_at).not.toBeNull();
      chat.app.sessions.repair(Date.now(), "the server restarted");
      expect(chat.app.sessions.byId(copied.session.id)?.status).toBe("done");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a title in the body names the fork, trimmed as a rename is", async () => {
    const chat = await chatApp();
    try {
      const source = await startChat(chat);
      await finish(chat, source.sessionId, source.script);
      const messageId = chat.app.sessions.messages(source.sessionId)[1]!.id;
      const titled = await chat.member.call(
        "POST",
        `/api/sessions/${source.sessionId}/fork`,
        { body: { messageId, agentId: chat.agentId, title: "  second try " } },
      );
      expect(titled.status).toBe(201);
      expect((await titled.json()).session.title).toBe("second try");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("refuses malformed bodies, unknown fields and an absent agent without creating rows", async () => {
    const chat = await chatApp();
    try {
      const source = await startChat(chat);
      await finish(chat, source.sessionId, source.script);
      const messageId = chat.app.sessions.messages(source.sessionId)[1]!.id;
      for (const body of [
        null,
        [],
        {},
        { messageId },
        { agentId: chat.agentId },
        { messageId: "", agentId: chat.agentId },
        { messageId: 42, agentId: chat.agentId },
        { messageId: "bad-id", agentId: chat.agentId },
        { messageId: "A".repeat(12), agentId: chat.agentId },
        { messageId, agentId: "" },
        { messageId, agentId: 42 },
        { messageId, agentId: null },
        { messageId, agentId: chat.agentId, title: "" },
        { messageId, agentId: chat.agentId, title: "two\nlines" },
        { messageId, agentId: chat.agentId, title: 7 },
        { messageId, agentId: chat.agentId, title: "x".repeat(81) },
        { messageId, agentId: chat.agentId, name: "unexpected" },
      ]) {
        const response = await chat.member.call(
          "POST",
          `/api/sessions/${source.sessionId}/fork`,
          { body },
        );
        expect(response.status).toBe(400);
      }
      const invalidJson = await chat.member.call(
        "POST",
        `/api/sessions/${source.sessionId}/fork`,
        { raw: '{"messageId":' },
      );
      expect(invalidJson.status).toBe(400);
      const absent = await chat.member.call(
        "POST",
        `/api/sessions/${source.sessionId}/fork`,
        { body: { messageId, agentId: "000000000000" } },
      );
      expect(absent.status).toBe(400);
      expect(await absent.json()).toEqual({ error: "no such agent" });
      const body = JSON.stringify({ messageId, agentId: chat.agentId });
      const atCap = body.padEnd(MAX_SMALL_BODY, " ");
      const oversized = await chat.member.call(
        "POST",
        `/api/sessions/${source.sessionId}/fork`,
        {
          raw: `${atCap} `,
        },
      );
      expect(oversized.status).toBe(413);
      expect(chat.app.sessions.count(chat.projectId)).toBe(1);
      const boundary = await chat.member.call(
        "POST",
        `/api/sessions/${source.sessionId}/fork`,
        { raw: atCap },
      );
      expect(boundary.status).toBe(201);
      expect(chat.app.sessions.count(chat.projectId)).toBe(2);
      expect(chat.scripted.scripts).toHaveLength(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("refuses a streaming reply, a work reply, a tool and a failed answer", async () => {
    const chat = await chatApp();
    try {
      const source = await startChat(chat);
      const streaming = chat.app.sessions.messages(source.sessionId)[1]!;
      const refusal = async (messageId: string) => {
        const response = await chat.member.call(
          "POST",
          `/api/sessions/${source.sessionId}/fork`,
          { body: { messageId, agentId: chat.agentId } },
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "not a turn" });
      };
      await refusal(streaming.id);
      source.script.toolRound([timeCall]);
      source.script.end();
      const next = await waitScript(chat.scripted, 2);
      const rows = chat.app.sessions.messages(source.sessionId);
      await refusal(rows.find((row) => row.slot === "work")!.id);
      await refusal(rows.find((row) => row.kind === "tool")!.id);
      next.end();
      await settle(chat, source.sessionId);
      const failed = chat.app.sessions.messages(source.sessionId).at(-1)!;
      expect(failed.status).toBe("failed");
      await refusal(failed.id);
      expect(chat.app.sessions.count(chat.projectId)).toBe(1);
    } finally {
      await chat.app.shutdown();
    }
  });
});
