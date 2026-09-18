// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Session routes over the composed app: visibility, ordering, filters,
// details, deletion, repair and the guards around a running send.

import { describe, expect, test } from "bun:test";
import { compose } from "../../src/server/compose.ts";
import { type BusEvent, subscribe } from "../../src/server/lib/bus.ts";
import { silent } from "../../src/server/lib/log.ts";
import {
  chatMarkdown,
  RESTART_ERROR,
  RESULT_DISPLAY_CHARS,
  SessionStore,
  titleFrom,
  type UsagePort,
} from "../../src/server/sessions/index.ts";
import type { Tools } from "../../src/server/tools/index.ts";
import type { StreamRow } from "../../src/shared/api/sessions.ts";
import { fakeFetch, VERSION } from "../helpers/app.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  startChat,
  tick,
  waitScript,
} from "../helpers/chat.ts";
import { memoryDb } from "../helpers/db.ts";

async function finish(script: Script, content = "done") {
  script.reply(content);
  await tick();
  await tick();
}

function finishStoredReply(
  store: SessionStore,
  id: string,
  content: string,
  slot: "work" | "answer" | null,
) {
  return store.finishReply(id, {
    content,
    reasoning: "",
    reasoningDetails: [],
    html: content,
    status: "done",
    error: null,
    finishReason: "stop",
    slot,
    toolCalls: null,
    ttftMs: null,
    thinkingMs: null,
    finishedAt: 1,
  });
}

function fixedTools(content: string): Tools {
  return {
    offered: () => ({
      tools: [
        {
          name: "datetime",
          description: "the current time",
          parameters: { type: "object", properties: {} },
        },
      ],
      search: null,
      skills: { block: "", skills: [] },
      mcp: [],
      mcpPrompt: { text: "", digest: {} },
      mcpCatalog: "",
      memory: null,
    }),
    run: () => Promise.resolve({ content, error: false }),
  };
}

const timeCall = {
  id: "time-1",
  name: "datetime",
  arguments: '{"timezone":"UTC"}',
};

function addTeam(chat: ChatApp, id: string) {
  chat.app.db
    .query(
      "insert into projects (id, kind, name, owner_id, created_at) values (?, 'team', ?, ?, ?)",
    )
    .run(id, id, chat.memberId, chat.app.now.value);
  chat.app.db
    .query(
      "insert into memberships (project_id, user_id, created_at) values (?, ?, ?)",
    )
    .run(id, chat.memberId, chat.app.now.value);
}

describe("GET /api/sessions", () => {
  test("lists visible chats running first and then by activity", async () => {
    const chat = await chatApp();
    const adminProject = chat.app.projects.personal(chat.adminId)!.id;
    const old = await startChat(chat, "old member chat");
    await finish(old.script);
    chat.app.now.value += 100;
    const recent = await startChat(chat, "recent member chat");
    await finish(recent.script);
    chat.app.now.value += 100;
    const running = await startChat(chat, "running member chat");
    const admin = await startChat(chat, "admin chat", chat.admin, adminProject);

    const memberBody = await (
      await chat.member.call("GET", "/api/sessions")
    ).json();
    expect(
      memberBody.rows.map((row: { session: { id: string } }) => row.session.id),
    ).toEqual([running.sessionId, recent.sessionId, old.sessionId]);
    const adminBody = await (
      await chat.admin.call("GET", "/api/sessions")
    ).json();
    expect(
      adminBody.rows.map((row: { session: { id: string } }) => row.session.id),
    ).toEqual([admin.sessionId]);

    await finish(running.script);
    await finish(admin.script);
    chat.app.socket.dispose();
  });

  test("filters titles case-insensitively and narrows to a project", async () => {
    const chat = await chatApp();
    addTeam(chat, "sessions-team");
    const personal = await startChat(chat, "Alpha Release");
    await finish(personal.script);
    const team = await startChat(
      chat,
      "Team Notes",
      chat.member,
      "sessions-team",
    );
    await finish(team.script);

    const searched = await (
      await chat.member.call("GET", "/api/sessions?q=pHa")
    ).json();
    expect(searched.rows.map((row: StreamRow) => row.session.id)).toEqual([
      personal.sessionId,
    ]);
    const narrowed = await (
      await chat.member.call("GET", "/api/sessions?project=sessions-team")
    ).json();
    expect(narrowed.rows.map((row: StreamRow) => row.session.id)).toEqual([
      team.sessionId,
    ]);
    const adminProject = chat.app.projects.personal(chat.adminId)!.id;
    expect(
      (await chat.member.call("GET", `/api/sessions?project=${adminProject}`))
        .status,
    ).toBe(404);
    chat.app.socket.dispose();
  });

  test("answers the last send and the last eligible line", async () => {
    const chat = await chatApp();
    const completed = await startChat(chat, "# question");
    await finish(completed.script, "\n## Final answer\nsecond line");
    const store = chat.app.sessions;
    const answer = store.message(completed.detail.messages[1].id)!;

    const summary = store.addSummary({
      sessionId: completed.sessionId,
      sendId: completed.detail.send.id,
      round: 2,
      agentId: chat.agentId,
      model: "model",
      now: chat.app.now.value,
    });
    finishStoredReply(store, summary.id, "summary ignored", null);
    const work = store.addReply({
      sessionId: completed.sessionId,
      sendId: completed.detail.send.id,
      round: 3,
      agentId: chat.agentId,
      model: "model",
      now: chat.app.now.value,
    });
    finishStoredReply(store, work.id, "work ignored", "work");
    const streaming = store.addReply({
      sessionId: completed.sessionId,
      sendId: completed.detail.send.id,
      round: 4,
      agentId: chat.agentId,
      model: "model",
      now: chat.app.now.value,
    });
    store.writeReply(streaming.id, {
      content: "streaming ignored",
      reasoning: "",
      reasoningDetails: [],
    });

    chat.app.now.value += 1;
    const failed = store.create({
      projectId: chat.projectId,
      ownerId: chat.memberId,
      agentId: chat.agentId,
      title: "failed",
      now: chat.app.now.value,
    });
    const failedSend = store.createSend({
      sessionId: failed.id,
      userId: chat.memberId,
      agentId: chat.agentId,
      providerId: chat.providerId,
      model: "model",
      firstMessageId: "failed-user",
      now: chat.app.now.value,
    });
    const failedUser = store.addUserMessage({
      id: "failed-user",
      sessionId: failed.id,
      sendId: failedSend.id,
      userId: chat.memberId,
      content: "- User line\nmore",
      now: chat.app.now.value,
    });
    store.finishSend(failedSend.id, {
      status: "failed",
      cause: "failure",
      error: "failed before a reply",
      rounds: 0,
      toolCalls: 0,
      memoryError: null,
      memorySkipped: null,
      finishedAt: chat.app.now.value,
    });
    store.touch(failed.id, { status: "failed", now: chat.app.now.value });

    const body = await (await chat.member.call("GET", "/api/sessions")).json();
    const rows = new Map<string, StreamRow>(
      body.rows.map((row: StreamRow) => [row.session.id, row]),
    );
    expect(rows.get(completed.sessionId)).toMatchObject({
      send: { id: completed.detail.send.id },
      last: { seq: answer.seq, author: "coder", text: "Final answer" },
    });
    expect(rows.get(failed.id)).toMatchObject({
      send: { id: failedSend.id },
      last: { seq: failedUser.seq, author: "caelea", text: "User line" },
    });
    chat.app.socket.dispose();
  });
});

describe("GET /api/sessions/:id", () => {
  test("answers messages, send and live without exposing personal chats", async () => {
    const chat = await chatApp();
    const mine = await startChat(chat, "member detail");
    const detailRes = await chat.member.call(
      "GET",
      `/api/sessions/${mine.sessionId}`,
    );
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.messages).toHaveLength(2);
    expect(detail.send.id).toBe(mine.detail.send.id);
    expect(detail.live).toMatchObject({
      sendId: mine.detail.send.id,
      messageId: mine.detail.messages[1].id,
    });
    expect(
      (await chat.admin.call("GET", `/api/sessions/${mine.sessionId}`)).status,
    ).toBe(404);

    const adminProject = chat.app.projects.personal(chat.adminId)!.id;
    const theirs = await startChat(
      chat,
      "admin detail",
      chat.admin,
      adminProject,
    );
    expect(
      (await chat.member.call("GET", `/api/sessions/${theirs.sessionId}`))
        .status,
    ).toBe(404);
    await finish(mine.script);
    await finish(theirs.script);
    chat.app.socket.dispose();
  });

  test.serial(
    "keeps tool results in storage and strips every wire row",
    async () => {
      const result = "résultat 🙂";
      const chat = await chatApp({ tools: fixedTools(result) });
      const changed: Extract<BusEvent, { type: "session.changed" }>["data"][] =
        [];
      const unsubscribe = subscribe((event) => {
        if (event.type === "session.changed") changed.push(event.data);
      });
      const started = await startChat(chat, "use a tool");
      started.script.toolRound([timeCall]);
      started.script.end();
      const answer = await waitScript(chat.scripted, 2);

      const providerTool = (
        answer.body.messages as { role: string; content: string }[]
      ).find((message) => message.role === "tool");
      expect(providerTool?.content).toBe(result);

      const toolEnd = changed.find((event) =>
        event.messages.some(
          (message) => message.kind === "tool" && message.status === "done",
        ),
      );
      expect(toolEnd).toBeDefined();
      expect(toolEnd!.last).toBeUndefined();
      expect(
        toolEnd!.messages.find((message) => message.kind === "tool"),
      ).toMatchObject({
        content: "",
        resultBytes: new TextEncoder().encode(result).length,
      });

      await finish(answer, "answer");
      const response = await chat.member.call(
        "GET",
        `/api/sessions/${started.sessionId}`,
      );
      const detail = await response.json();
      const tool = detail.messages.find(
        (message: { kind: string }) => message.kind === "tool",
      );
      expect(tool).toMatchObject({
        content: "",
        resultBytes: new TextEncoder().encode(result).length,
      });
      expect(
        detail.messages
          .filter((message: { kind: string }) => message.kind !== "tool")
          .every(
            (message: { resultBytes: number | null }) =>
              message.resultBytes === null,
          ),
      ).toBe(true);
      expect(detail.messages[0].content).toBe("use a tool");
      expect(detail.messages.at(-1).content).toBe("answer");

      const stored = chat.app.sessions.message(tool.id)!;
      expect(stored).toMatchObject({ content: result, resultBytes: null });
      const resultResponse = await chat.member.call(
        "GET",
        `/api/sessions/${started.sessionId}/messages/${tool.id}/result`,
      );
      expect(resultResponse.status).toBe(200);
      expect(await resultResponse.json()).toEqual({
        content: result,
        bytes: new TextEncoder().encode(result).length,
        cut: false,
      });
      unsubscribe();
      chat.app.socket.dispose();
    },
  );

  test("a failed tool leaves its error text off the wire too", async () => {
    const chat = await chatApp();
    const started = await startChat(chat, "failed tool");
    const [streaming] = chat.app.sessions.addToolRows([
      {
        sessionId: started.sessionId,
        sendId: started.detail.send.id,
        round: 1,
        toolCallId: "failed-call",
        toolName: "webfetch",
        now: chat.app.now.value,
      },
    ]);
    const tool = chat.app.sessions.finishTool(streaming!.id, {
      content: "Error: HTTP status 404",
      status: "failed",
      error: "Error: HTTP status 404",
      finishedAt: chat.app.now.value,
    })!;
    const detail = await (
      await chat.member.call("GET", `/api/sessions/${started.sessionId}`)
    ).json();
    expect(
      detail.messages.find((message: { id: string }) => message.id === tool.id),
    ).toMatchObject({
      status: "failed",
      content: "",
      error: null,
      resultBytes: 22,
    });
    const result = await chat.member.call(
      "GET",
      `/api/sessions/${started.sessionId}/messages/${tool.id}/result`,
    );
    expect(await result.json()).toEqual({
      content: "Error: HTTP status 404",
      bytes: 22,
      cut: false,
    });
    await finish(started.script);
    chat.app.socket.dispose();
  });

  test("never cuts a result inside a surrogate pair", async () => {
    const chat = await chatApp();
    const started = await startChat(chat, "emoji result");
    const content = `${"a".repeat(RESULT_DISPLAY_CHARS - 1)}\u{1F642}b`;
    const [streaming] = chat.app.sessions.addToolRows([
      {
        sessionId: started.sessionId,
        sendId: started.detail.send.id,
        round: 1,
        toolCallId: "emoji-call",
        toolName: "webfetch",
        now: chat.app.now.value,
      },
    ]);
    const tool = chat.app.sessions.finishTool(streaming!.id, {
      content,
      status: "done",
      error: null,
      finishedAt: chat.app.now.value,
    })!;
    const result = await chat.member.call(
      "GET",
      `/api/sessions/${started.sessionId}/messages/${tool.id}/result`,
    );
    expect(await result.json()).toEqual({
      content: "a".repeat(RESULT_DISPLAY_CHARS - 1),
      bytes: RESULT_DISPLAY_CHARS + 4,
      cut: true,
    });
    await finish(started.script);
    chat.app.socket.dispose();
  });

  test("cuts tool result display and rejects unavailable rows", async () => {
    const chat = await chatApp();
    const started = await startChat(chat, "long result");
    const long = "x".repeat(RESULT_DISPLAY_CHARS + 1);
    const [streaming] = chat.app.sessions.addToolRows([
      {
        sessionId: started.sessionId,
        sendId: started.detail.send.id,
        round: 1,
        toolCallId: "long-call",
        toolName: "webfetch",
        now: chat.app.now.value,
      },
    ]);
    const tool = chat.app.sessions.finishTool(streaming!.id, {
      content: long,
      status: "done",
      error: null,
      finishedAt: chat.app.now.value,
    })!;
    const response = await chat.member.call(
      "GET",
      `/api/sessions/${started.sessionId}/messages/${tool.id}/result`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      content: "x".repeat(RESULT_DISPLAY_CHARS),
      bytes: long.length,
      cut: true,
    });

    const other = chat.app.sessions.create({
      projectId: chat.projectId,
      ownerId: chat.memberId,
      agentId: chat.agentId,
      title: "other",
      now: chat.app.now.value,
    });
    expect(
      (
        await chat.member.call(
          "GET",
          `/api/sessions/${other.id}/messages/${tool.id}/result`,
        )
      ).status,
    ).toBe(404);
    const replyId = started.detail.messages[1].id;
    expect(
      (
        await chat.member.call(
          "GET",
          `/api/sessions/${started.sessionId}/messages/${replyId}/result`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await chat.member.call(
          "GET",
          `/api/sessions/000000000000/messages/${tool.id}/result`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await chat.member.call(
          "GET",
          `/api/sessions/${started.sessionId}/messages/bad-id/result`,
        )
      ).status,
    ).toBe(400);
    await finish(started.script);
    chat.app.socket.dispose();
  });
});

describe("PATCH /api/sessions/:id", () => {
  test.serial(
    "renames a running chat too, with a revision and an envelope",
    async () => {
      const chat = await chatApp();
      const started = await startChat(chat);
      // a send never writes the title, so a rename under one goes
      // through and the reply still lands
      const running = await chat.member.call(
        "PATCH",
        `/api/sessions/${started.sessionId}`,
        { body: { title: "Named Early" } },
      );
      expect(running.status).toBe(200);
      expect((await running.json()).session.status).toBe("running");
      await finish(started.script);
      expect(chat.app.sessions.byId(started.sessionId)?.title).toBe(
        "Named Early",
      );
      const before = chat.app.sessions.byId(started.sessionId)!.revision;
      const events: BusEvent[] = [];
      const off = subscribe((event) => events.push(event));
      const renamed = await chat.member.call(
        "PATCH",
        `/api/sessions/${started.sessionId}`,
        { body: { title: " Kept As Typed " } },
      );
      expect(renamed.status).toBe(200);
      const detail = await renamed.json();
      expect(detail.session.title).toBe("Kept As Typed");
      expect(detail.session.revision).toBe(before + 1);
      expect(detail.session.status).toBe("done");
      expect(detail.messages.length).toBe(2);
      expect(events).toEqual([
        {
          type: "session.changed",
          data: {
            projectId: chat.projectId,
            session: detail.session,
            messages: [],
            send: detail.send,
          },
        },
      ]);
      off();
      expect(
        (
          await chat.member.call(
            "PATCH",
            `/api/sessions/${started.sessionId}`,
            {
              body: { title: "" },
            },
          )
        ).status,
      ).toBe(400);
      chat.app.socket.dispose();
    },
  );
});

describe("DELETE /api/sessions/:id", () => {
  test("refuses a running chat and deletes its rows after it finishes", async () => {
    const chat = await chatApp();
    const started = await startChat(chat);
    const running = await chat.member.call(
      "DELETE",
      `/api/sessions/${started.sessionId}`,
    );
    expect(running.status).toBe(409);
    await finish(started.script);
    const deleted = await chat.member.call(
      "DELETE",
      `/api/sessions/${started.sessionId}`,
    );
    expect(deleted.status).toBe(200);
    expect(chat.app.sessions.byId(started.sessionId)).toBeNull();
    expect(chat.app.sessions.messages(started.sessionId)).toEqual([]);
    expect(chat.app.sessions.lastSend(started.sessionId)).toBeNull();
    chat.app.socket.dispose();
  });

  test("the owner deletes a chat in a team project", async () => {
    const chat = await chatApp();
    chat.app.db
      .query(
        "insert into projects (id, kind, name, owner_id, created_at) values ('t1', 'team', 'ops', ?, 0)",
      )
      .run(chat.memberId);
    chat.app.db
      .query(
        "insert into memberships (project_id, user_id, created_at) values ('t1', ?, 0)",
      )
      .run(chat.memberId);
    const started = await startChat(chat, "hello", chat.member, "t1");
    await finish(started.script);
    const deleted = await chat.member.call(
      "DELETE",
      `/api/sessions/${started.sessionId}`,
    );
    expect(deleted.status).toBe(200);
    expect(chat.app.sessions.byId(started.sessionId)).toBeNull();
    chat.app.socket.dispose();
  });
});

describe("GET /api/projects/:id/agents", () => {
  test("lists every agent only for a visible project", async () => {
    const chat = await chatApp();
    const visible = await chat.member.call(
      "GET",
      `/api/projects/${chat.projectId}/agents`,
    );
    expect(visible.status).toBe(200);
    expect(await visible.json()).toEqual({
      agents: [expect.objectContaining({ id: chat.agentId, name: "coder" })],
    });
    const adminProject = chat.app.projects.personal(chat.adminId)!.id;
    expect(
      (await chat.member.call("GET", `/api/projects/${adminProject}/agents`))
        .status,
    ).toBe(404);
    chat.app.socket.dispose();
  });
});

describe("session titles", () => {
  test("uses the trimmed first line cut to 80 characters", async () => {
    const chat = await chatApp();
    const line = "a".repeat(100);
    const started = await startChat(chat, `  ${line}  \nsecond line`);
    expect(started.detail.session.title).toBe(`${"a".repeat(79)}…`);
    expect(started.detail.session.title).toBe(titleFrom(`  ${line}  \nnext`));
    await finish(started.script);
    chat.app.socket.dispose();
  });
});

describe("agent deletion", () => {
  test("refuses an agent with a chat and allows it after chat deletion", async () => {
    const chat = await chatApp();
    const started = await startChat(chat);
    await finish(started.script);
    const used = await chat.admin.call("DELETE", `/api/agents/${chat.agentId}`);
    expect(used.status).toBe(409);
    expect(await used.json()).toEqual({ error: "a chat uses coder" });
    expect(
      (await chat.member.call("DELETE", `/api/sessions/${started.sessionId}`))
        .status,
    ).toBe(200);
    expect(
      (await chat.admin.call("DELETE", `/api/agents/${chat.agentId}`)).status,
    ).toBe(200);
    chat.app.socket.dispose();
  });
});

describe("boot repair", () => {
  test.serial(
    "fails rows left running and publishes their repaired revision",
    async () => {
      const chat = await chatApp();
      const store = chat.app.sessions;
      const session = store.create({
        projectId: chat.projectId,
        ownerId: chat.memberId,
        agentId: chat.agentId,
        title: "interrupted",
        now: chat.app.now.value,
      });
      // the send row is written first, so the messages' send_id holds
      const sendId = "repair-send";
      const send = store.createSend({
        id: sendId,
        sessionId: session.id,
        userId: chat.memberId,
        agentId: chat.agentId,
        providerId: chat.providerId,
        model: "model",
        firstMessageId: "repair-user",
        now: chat.app.now.value,
      });
      store.addUserMessage({
        id: "repair-user",
        sessionId: session.id,
        sendId,
        userId: chat.memberId,
        content: "hello",
        now: chat.app.now.value,
      });
      const reply = store.addReply({
        sessionId: session.id,
        sendId,
        round: 1,
        agentId: chat.agentId,
        model: "model",
        now: chat.app.now.value,
      });
      const before = store.touch(session.id, {
        status: "running",
        now: chat.app.now.value,
      })!;
      const seen: Extract<BusEvent, { type: "session.changed" }>["data"][] = [];
      const stop = subscribe((event) => {
        if (event.type === "session.changed") seen.push(event.data);
      });
      chat.app.socket.dispose();
      const fake = fakeFetch();
      const repaired = await compose({
        db: chat.app.db,
        secret: (kind, name) =>
          kind === "user-" && name === "user-admin" ? "hunter2-test" : null,
        clock: () => chat.app.now.value,
        fetcher: fake.fetcher,
        log: () => silent,
        version: VERSION,
        secureCookie: false,
        trustProxy: false,
      });
      stop();

      expect(repaired.sessions.byId(session.id)).toMatchObject({
        status: "failed",
        revision: before.revision + 1,
      });
      expect(repaired.sessions.message(reply.id)).toMatchObject({
        status: "failed",
        error: RESTART_ERROR,
      });
      expect(repaired.sessions.send(send.id)).toMatchObject({
        status: "failed",
        cause: "restart",
        error: RESTART_ERROR,
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        projectId: chat.projectId,
        session: { id: session.id, revision: before.revision + 1 },
        send: { id: send.id, cause: "restart" },
      });
      // the repair now carries the rows it changed, so the socket can
      // apply them without a refetch: the reply it ended, placed answer
      expect(seen[0].messages).toEqual([
        expect.objectContaining({
          id: reply.id,
          status: "failed",
          slot: "answer",
          error: RESTART_ERROR,
        }),
      ]);
      repaired.socket.dispose();
    },
  );
});

describe("message limits and admission", () => {
  test("refuses a 300 KB message on create and send", async () => {
    const chat = await chatApp();
    const oversized = "x".repeat(300 * 1024);
    const create = await chat.member.call("POST", "/api/sessions", {
      body: {
        projectId: chat.projectId,
        agentId: chat.agentId,
        message: oversized,
      },
    });
    // The JSON exceeds the route cap before the parser, so the body
    // reader refuses it with 413 rather than the parser's 400.
    expect(create.status).toBe(413);

    const started = await startChat(chat);
    await finish(started.script);
    const send = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/messages`,
      { body: { message: oversized } },
    );
    expect(send.status).toBe(413);
    chat.app.socket.dispose();
  });

  test("refuses a second message while the first is running", async () => {
    const chat = await chatApp();
    const started = await startChat(chat);
    const second = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/messages`,
      { body: { message: "again" } },
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "Oana Mangiurea is sending" });
    await finish(started.script);
    chat.app.socket.dispose();
  });
});

describe("the usage on the summary", () => {
  test("the detail and the list carry the last counted round, by order, not by time", async () => {
    const chat = await chatApp();
    const first = await startChat(chat, "one");
    first.script.content("a");
    first.script.finish();
    first.script.usage({ prompt: 10, completion: 5 });
    first.script.end();
    await tick();
    await tick();
    // the fake clock does not move, so the second round has the same
    // timestamp and the same round number as the first
    const pending = chat.scripted.next();
    await chat.member.call(
      "POST",
      `/api/sessions/${first.sessionId}/messages`,
      {
        body: { message: "two" },
      },
    );
    const second = await pending;
    second.content("b");
    second.finish();
    second.usage({ prompt: 40, completion: 9 });
    second.end();
    await tick();
    await tick();
    const detail = await (
      await chat.member.call("GET", `/api/sessions/${first.sessionId}`)
    ).json();
    expect(detail.session.usage).toMatchObject({
      promptTokens: 40,
      completionTokens: 9,
      contextLength: 1048576,
    });
    const list = await (await chat.member.call("GET", "/api/sessions")).json();
    expect(list.rows[0].session.usage).toMatchObject({ promptTokens: 40 });
    chat.app.socket.dispose();
  });

  test("a stopped send after a counted one keeps the counted round", async () => {
    const chat = await chatApp();
    const started = await startChat(chat, "one");
    await finish(started.script);
    const pending = chat.scripted.next();
    await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/messages`,
      { body: { message: "two" } },
    );
    const second = await pending;
    second.content("partial");
    await chat.member.call("POST", `/api/sessions/${started.sessionId}/stop`);
    await tick();
    await tick();
    const detail = await (
      await chat.member.call("GET", `/api/sessions/${started.sessionId}`)
    ).json();
    expect(detail.session.status).toBe("stopped");
    expect(detail.session.usage).toMatchObject({ promptTokens: 10 });
    chat.app.socket.dispose();
  });
});

// the tool-loop store APIs over a bare db, without the runner: the
// send row inserted first, the reply placed by slot, tool rows added
// and finished under the status guard, and repair stopping a partial
// tool row and placing the reply it ends.
const noUsage: UsagePort = {
  latest: () => null,
  latestFor: () => new Map(),
  deleteSession: () => 0,
};

function seededStore() {
  const db = memoryDb();
  db.query(
    "insert into users (id, username, full_name, email, role, password_hash, created_at) values ('u', 'user', 'User', 'user@example.com', 'member', 'x', 0)",
  ).run();
  db.query(
    "insert into projects (id, kind, name, owner_id, created_at) values ('p', 'personal', 'personal', 'u', 0)",
  ).run();
  db.query(
    "insert into providers (id, name, wire, base_url, created_at) values ('pr', 'prov', 'openai-compatible', 'http://x', 0)",
  ).run();
  db.query(
    "insert into agents (id, name, provider_id, model, model_name, created_at) values ('a', 'agent', 'pr', 'm', 'M', 0)",
  ).run();
  const store = new SessionStore(db, noUsage);
  const session = store.create({
    projectId: "p",
    ownerId: "u",
    agentId: "a",
    title: "chat",
    now: 0,
  });
  return { db, store, session };
}

describe("the tool-loop store", () => {
  test("places a reply, adds and finishes tool rows under the guard", () => {
    const { db, store, session } = seededStore();
    const send = store.createSend({
      id: "s1",
      sessionId: session.id,
      userId: "u",
      agentId: "a",
      providerId: "pr",
      model: "m",
      firstMessageId: "user1",
      now: 0,
    });
    store.addUserMessage({
      id: "user1",
      sessionId: session.id,
      sendId: send.id,
      userId: "u",
      content: "hi",
      now: 0,
    });
    const reply = store.addReply({
      sessionId: session.id,
      sendId: send.id,
      round: 1,
      agentId: "a",
      model: "m",
      now: 0,
    });
    // the first call delta moves the row into the fold; a second delta
    // writes nothing
    expect(store.markRoundWork(reply.id)!.slot).toBe("work");
    expect(store.markRoundWork(reply.id)).toBeNull();

    const work = store.finishReply(reply.id, {
      content: "",
      reasoning: "",
      reasoningDetails: [],
      html: "",
      status: "done",
      error: null,
      finishReason: "tool_calls",
      slot: "work",
      toolCalls: [{ id: "c1", name: "datetime", arguments: "{}" }],
      ttftMs: null,
      thinkingMs: null,
      finishedAt: 1,
    })!;
    expect(work.slot).toBe("work");
    expect(work.toolCalls).toEqual([
      { id: "c1", name: "datetime", arguments: "{}" },
    ]);

    const [tool] = store.addToolRows([
      {
        sessionId: session.id,
        sendId: send.id,
        round: 1,
        toolCallId: "c1",
        toolName: "datetime",
        now: 1,
      },
    ]);
    expect(tool.kind).toBe("tool");
    expect(tool.status).toBe("streaming");
    expect(tool.toolCallId).toBe("c1");

    const done = store.finishTool(tool.id, {
      content: "12:00",
      status: "done",
      error: null,
      finishedAt: 2,
    })!;
    expect(done.status).toBe("done");
    expect(done.content).toBe("12:00");
    // the guard: a second finish after the status moved writes nothing
    expect(
      store.finishTool(tool.id, {
        content: "late",
        status: "failed",
        error: "x",
        finishedAt: 3,
      }),
    ).toBeNull();
    expect(store.message(tool.id)!.content).toBe("12:00");
    db.close();
  });

  test("the answer unique index forbids two answers in one send", () => {
    const { db, store, session } = seededStore();
    const send = store.createSend({
      id: "s2",
      sessionId: session.id,
      userId: "u",
      agentId: "a",
      providerId: "pr",
      model: "m",
      firstMessageId: "u2",
      now: 0,
    });
    store.addUserMessage({
      id: "u2",
      sessionId: session.id,
      sendId: send.id,
      userId: "u",
      content: "hi",
      now: 0,
    });
    const first = store.addReply({
      sessionId: session.id,
      sendId: send.id,
      round: 1,
      agentId: "a",
      model: "m",
      now: 0,
    });
    store.finishReply(first.id, {
      content: "answer",
      reasoning: "",
      reasoningDetails: [],
      html: "answer",
      status: "done",
      error: null,
      finishReason: "stop",
      slot: "answer",
      toolCalls: null,
      ttftMs: null,
      thinkingMs: null,
      finishedAt: 1,
    });
    const second = store.addReply({
      sessionId: session.id,
      sendId: send.id,
      round: 2,
      agentId: "a",
      model: "m",
      now: 1,
    });
    expect(() =>
      store.finishReply(second.id, {
        content: "again",
        reasoning: "",
        reasoningDetails: [],
        html: "again",
        status: "done",
        error: null,
        finishReason: "stop",
        slot: "answer",
        toolCalls: null,
        ttftMs: null,
        thinkingMs: null,
        finishedAt: 2,
      }),
    ).toThrow();
    db.close();
  });

  test("repair stops a partial tool row and answers the reply it ends", () => {
    const { db, store, session } = seededStore();
    const send = store.createSend({
      id: "s3",
      sessionId: session.id,
      userId: "u",
      agentId: "a",
      providerId: "pr",
      model: "m",
      firstMessageId: "u3",
      now: 0,
    });
    store.addUserMessage({
      id: "u3",
      sessionId: session.id,
      sendId: send.id,
      userId: "u",
      content: "hi",
      now: 0,
    });
    const reply = store.addReply({
      sessionId: session.id,
      sendId: send.id,
      round: 1,
      agentId: "a",
      model: "m",
      now: 0,
    });
    const [tool] = store.addToolRows([
      {
        sessionId: session.id,
        sendId: send.id,
        round: 1,
        toolCallId: "c1",
        toolName: "webfetch",
        now: 0,
      },
    ]);
    store.touch(session.id, { status: "running", now: 0 });

    const repaired = store.repair(1, "restart");
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.session.status).toBe("failed");
    expect(repaired[0]!.send).toMatchObject({ cause: "restart" });
    const byId = new Map(repaired[0]!.messages.map((m) => [m.id, m]));
    expect(byId.get(reply.id)).toMatchObject({
      status: "failed",
      slot: "answer",
    });
    expect(byId.get(tool.id)).toMatchObject({
      status: "stopped",
      error: "restart",
    });
    // nothing streams after a repair, so foreign keys still check
    expect(db.query("pragma foreign_key_check").all()).toEqual([]);
    db.close();
  });

  test("repair includes rows whose session status was already stale", () => {
    const { db, store, session } = seededStore();
    const send = store.createSend({
      id: "stale-send",
      sessionId: session.id,
      userId: "u",
      agentId: "a",
      providerId: "pr",
      model: "m",
      firstMessageId: "stale-user",
      now: 0,
    });
    store.addUserMessage({
      id: "stale-user",
      sessionId: session.id,
      sendId: send.id,
      userId: "u",
      content: "hi",
      now: 0,
    });
    const reply = store.addReply({
      sessionId: session.id,
      sendId: send.id,
      round: 1,
      agentId: "a",
      model: "m",
      now: 0,
    });
    store.touch(session.id, { status: "done", now: 0 });

    const repaired = store.repair(1, "restart");

    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.messages).toEqual([
      expect.objectContaining({
        id: reply.id,
        status: "failed",
        slot: "answer",
      }),
    ]);
    expect(repaired[0]!.send).toMatchObject({
      id: send.id,
      status: "failed",
      cause: "restart",
    });
    expect(repaired[0]!.session.status).toBe("failed");
    db.close();
  });

  test("repair fails a streaming summary without placing it", () => {
    const { db, store, session } = seededStore();
    const send = store.createSend({
      id: "summary-send",
      kind: "compact",
      sessionId: session.id,
      userId: "u",
      agentId: "a",
      providerId: "pr",
      model: "m",
      firstMessageId: "summary-user",
      now: 0,
    });
    store.addUserMessage({
      id: "summary-user",
      sessionId: session.id,
      sendId: send.id,
      userId: "u",
      content: "hi",
      now: 0,
    });
    const summary = store.addSummary({
      sessionId: session.id,
      sendId: send.id,
      round: 1,
      agentId: "a",
      model: "m",
      now: 0,
    });
    store.touch(session.id, { status: "running", now: 0 });

    const repaired = store.repair(1, "restart");
    expect(repaired[0]!.messages).toEqual([
      expect.objectContaining({
        id: summary.id,
        kind: "summary",
        status: "failed",
        slot: null,
        promptTokens: null,
      }),
    ]);
    expect(repaired[0]!.send).toMatchObject({
      id: send.id,
      cause: "restart",
    });
    expect(db.query("pragma foreign_key_check").all()).toEqual([]);
    db.close();
  });

  test("repair places a memory-phase reply as work and records its error", () => {
    const { db, store, session } = seededStore();
    const send = store.createSend({
      id: "memory-repair-send",
      kind: "run",
      sessionId: session.id,
      userId: "u",
      agentId: "a",
      providerId: "pr",
      model: "m",
      firstMessageId: "memory-repair-user",
      now: 0,
    });
    store.addUserMessage({
      id: "memory-repair-user",
      sessionId: session.id,
      sendId: send.id,
      userId: "u",
      content: "run",
      now: 0,
    });
    const answer = store.addReply({
      sessionId: session.id,
      sendId: send.id,
      round: 1,
      agentId: "a",
      model: "m",
      now: 0,
    });
    store.finishReply(answer.id, {
      content: "answer",
      reasoning: "",
      reasoningDetails: [],
      html: "",
      status: "done",
      error: null,
      finishReason: "stop",
      slot: "answer",
      toolCalls: null,
      ttftMs: null,
      thinkingMs: null,
      finishedAt: 1,
    });
    const phase = store.addReply({
      sessionId: session.id,
      sendId: send.id,
      round: 2,
      agentId: "a",
      model: "m",
      now: 2,
    });
    db.query("update sends set memory_round = 2 where id = ?").run(send.id);
    store.touch(session.id, { status: "running", now: 2 });

    const repaired = store.repair(3, "restart");

    expect(repaired[0]!.messages).toEqual([
      expect.objectContaining({
        id: phase.id,
        status: "failed",
        slot: "work",
      }),
    ]);
    expect(store.message(answer.id)).toMatchObject({
      status: "done",
      slot: "answer",
    });
    expect(repaired[0]!.send).toMatchObject({
      cause: "restart",
      memoryRound: 2,
      memoryError: "restart",
    });
    db.close();
  });

  test("finishSend records the counters", () => {
    const { db, store, session } = seededStore();
    const send = store.createSend({
      id: "s4",
      sessionId: session.id,
      userId: "u",
      agentId: "a",
      providerId: "pr",
      model: "m",
      firstMessageId: "u4",
      now: 0,
    });
    store.addUserMessage({
      id: "u4",
      sessionId: session.id,
      sendId: send.id,
      userId: "u",
      content: "hi",
      now: 0,
    });
    expect(
      store.bumpCounters(send.id, { rounds: 2, toolCalls: 3 }),
    ).toMatchObject({ rounds: 2, toolCalls: 3 });
    const ended = store.finishSend(send.id, {
      status: "done",
      cause: "finish",
      error: null,
      rounds: 2,
      toolCalls: 3,
      memoryError: null,
      memorySkipped: null,
      finishedAt: 5,
    })!;
    expect(ended).toMatchObject({ rounds: 2, toolCalls: 3, status: "done" });
    db.close();
  });
});

describe("GET /api/sessions/:id/markdown", () => {
  test("writes the messages and answers and leaves the work out", () => {
    const { db, store, session } = seededStore();
    const send = store.createSend({
      id: "s1",
      sessionId: session.id,
      userId: "u",
      agentId: "a",
      providerId: "pr",
      model: "m",
      firstMessageId: "user1",
      now: 0,
    });
    store.addUserMessage({
      id: "user1",
      sessionId: session.id,
      sendId: send.id,
      userId: "u",
      content: "what time is it?",
      now: 0,
    });
    const work = store.addReply({
      sessionId: session.id,
      sendId: send.id,
      round: 1,
      agentId: "a",
      model: "m",
      now: 0,
    });
    finishStoredReply(store, work.id, "let me check", "work");
    const [tool] = store.addToolRows([
      {
        sessionId: session.id,
        sendId: send.id,
        round: 1,
        toolCallId: "c1",
        toolName: "datetime",
        now: 1,
      },
    ]);
    store.finishTool(tool.id, {
      content: "12:00",
      status: "done",
      error: null,
      finishedAt: 2,
    });
    const answer = store.addReply({
      sessionId: session.id,
      sendId: send.id,
      round: 2,
      agentId: "a",
      model: "m",
      now: 2,
    });
    finishStoredReply(store, answer.id, "It is noon.\n", "answer");
    expect(
      chatMarkdown(session.title, store.exportRows(session.id), "UTC"),
    ).toBe(
      "# chat\n\n## @user 1970-01-01 00:00\n\nwhat time is it?\n\n## @agent 1970-01-01 00:00\n\nIt is noon.\n",
    );
    db.close();
  });

  test("answers the file in the caller's zone to whoever sees the chat", async () => {
    const chat = await chatApp();
    // the fake clock starts at 00:16:40 UTC on the epoch
    expect(chat.app.now.value).toBe(1_000_000);
    const path = (id: string, query = "?tz=Asia%2FTokyo") =>
      `/api/sessions/${id}/markdown${query}`;
    const started = await startChat(chat, "Plan the release, v2!");
    const running = await chat.member.call("GET", path(started.sessionId));
    expect(running.status).toBe(200);
    expect(await running.text()).toBe(
      "# Plan the release, v2!\n\n## @caelea 1970-01-01 09:16\n\nPlan the release, v2!\n",
    );
    chat.app.now.value += 60_000;
    await finish(started.script, "Ship it.");
    const res = await chat.member.call("GET", path(started.sessionId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="plan-the-release-v2.md"',
    );
    expect(await res.text()).toBe(
      "# Plan the release, v2!\n\n## @caelea 1970-01-01 09:16\n\nPlan the release, v2!\n\n## @coder 1970-01-01 09:17\n\nShip it.\n",
    );
    for (const query of ["", "?tz=Mars%2FOlympus", "?tz=UTC&x=1"]) {
      expect(
        (await chat.member.call("GET", path(started.sessionId, query))).status,
      ).toBe(400);
    }
    const hidden = await chat.admin.call("GET", path(started.sessionId));
    expect(hidden.status).toBe(404);
    chat.app.socket.dispose();
  });
});
