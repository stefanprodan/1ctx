// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../src/server/limits/index.ts";
import { SUMMARIZE, SUMMARY_LEAD } from "../../src/server/runner/context.ts";
import type { Message } from "../../src/shared/contracts/session.ts";
import type { ChatApp, Script } from "../helpers/chat.ts";
import { chatApp, startChat, tick, waitScript } from "../helpers/chat.ts";

const HIGH_PROMPT = 1_040_000;

async function settle(chat: ChatApp, sessionId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (chat.app.sessions.byId(sessionId)?.status !== "running") return;
    await tick();
  }
  throw new Error(`chat ${sessionId} did not settle`);
}

function finish(
  script: Script,
  text: string,
  prompt = 10,
  completion = 5,
): void {
  script.content(text);
  script.finish();
  script.usage({ prompt, completion });
  script.end();
}

async function compact(chat: ChatApp, sessionId: string) {
  const pending = chat.scripted.next();
  const response = await chat.member.call(
    "POST",
    `/api/sessions/${sessionId}/compact`,
  );
  return { response, script: await pending };
}

function rows(chat: ChatApp, sessionId: string): Message[] {
  return chat.app.sessions.messages(sessionId);
}

describe("compaction", () => {
  test("an over-threshold answer is summarized and the next send starts there", async () => {
    const chat = await chatApp();
    const started = await startChat(chat, "the old question");
    finish(started.script, "the answer", HIGH_PROMPT, 10);
    const summaryScript = await waitScript(chat.scripted, 2);
    expect(summaryScript.body.tools).toBeUndefined();
    expect(summaryScript.body.tool_choice).toBeUndefined();
    expect(summaryScript.body.max_tokens).toBe(4096);
    expect(summaryScript.body.messages).toEqual(
      expect.arrayContaining([{ role: "user", content: SUMMARIZE }]),
    );
    finish(summaryScript, "## Goal\n\n- Continue", 41_000, 200);
    await settle(chat, started.sessionId);

    const stored = rows(chat, started.sessionId);
    expect(stored).toHaveLength(3);
    expect(stored[1]).toMatchObject({
      kind: "reply",
      slot: "answer",
      status: "done",
      content: "the answer",
    });
    expect(stored[2]).toMatchObject({
      kind: "summary",
      slot: null,
      status: "done",
      promptTokens: 41_000,
    });
    expect(stored[2]!.html).not.toBe("");
    const wire = await (
      await chat.member.call("GET", `/api/sessions/${started.sessionId}`)
    ).json();
    expect(
      wire.messages.map((message: Message) => message.promptTokens),
    ).toEqual([null, null, 41_000]);
    expect(chat.app.sessions.lastSend(started.sessionId)).toMatchObject({
      kind: "chat",
      status: "done",
      rounds: 2,
    });
    expect(chat.app.sessions.byId(started.sessionId)?.usage).toMatchObject({
      promptTokens: 41_000,
      completionTokens: 200,
    });

    const nextPending = chat.scripted.next();
    const response = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/messages`,
      { body: { message: "the new question" } },
    );
    expect(response.status).toBe(201);
    const next = await nextPending;
    const messages = next.body.messages as {
      role: string;
      content: string;
      name?: string;
    }[];
    expect(messages.slice(1)).toEqual([
      {
        role: "user",
        content: `${SUMMARY_LEAD}\n\n## Goal\n\n- Continue`,
      },
      { role: "user", content: "the new question", name: "oana" },
    ]);
    expect(JSON.stringify(messages)).not.toContain("the old question");
    expect(JSON.stringify(messages)).not.toContain("the answer");
    finish(next, "new answer");
    await settle(chat, started.sessionId);
    chat.app.socket.dispose();
  });

  test("an under-threshold answer and a model without a window do not compact", async () => {
    const chat = await chatApp();
    const low = await startChat(chat, "low");
    finish(low.script, "answer", 100, 10);
    await settle(chat, low.sessionId);
    expect(chat.scripted.scripts).toHaveLength(1);
    expect(rows(chat, low.sessionId).map((row) => row.kind)).toEqual([
      "user",
      "reply",
    ]);

    chat.app.db
      .query("update agents set context_length = null where id = ?")
      .run(chat.agentId);
    const unknown = await startChat(chat, "unknown window");
    finish(unknown.script, "answer", HIGH_PROMPT, 10);
    await settle(chat, unknown.sessionId);
    expect(chat.scripted.scripts).toHaveLength(2);
    expect(rows(chat, unknown.sessionId).map((row) => row.kind)).toEqual([
      "user",
      "reply",
    ]);
    chat.app.socket.dispose();
  });

  test("a tool answer compacts, the answer a cap forced included", async () => {
    const chat = await chatApp();
    const tool = await startChat(chat, "what time");
    tool.script.toolRound([
      {
        id: "time-1",
        name: "get_current_time",
        arguments: '{"timezone":"UTC"}',
      },
    ]);
    tool.script.end();
    const answer = await waitScript(chat.scripted, 2);
    finish(answer, "noon", HIGH_PROMPT, 10);
    const summary = await waitScript(chat.scripted, 3);
    finish(summary, "## Goal\n\n- Know the time");
    await settle(chat, tool.sessionId);
    expect(rows(chat, tool.sessionId).at(-1)?.kind).toBe("summary");

    const changed = await chat.admin.call("PUT", "/api/limits", {
      body: { values: { ...DEFAULT_LIMITS, rounds: 2 } },
    });
    expect(changed.status).toBe(200);
    const capped = await startChat(chat, "cap");
    capped.script.toolRound([
      {
        id: "time-2",
        name: "get_current_time",
        arguments: '{"timezone":"UTC"}',
      },
    ]);
    capped.script.end();
    const forced = await waitScript(chat.scripted, 5);
    finish(forced, "forced answer", HIGH_PROMPT, 10);
    // the capped answer round is the request the tool results filled,
    // so it is measured like any answer
    const folded = await waitScript(chat.scripted, 6);
    finish(folded, "## Goal\n\n- Know the time, capped");
    await settle(chat, capped.sessionId);
    expect(chat.scripted.scripts).toHaveLength(6);
    expect(rows(chat, capped.sessionId).at(-1)?.kind).toBe("summary");
    chat.app.socket.dispose();
  });

  test("stopping a summary leaves the answer done and the summary stopped", async () => {
    const chat = await chatApp();
    const started = await startChat(chat);
    finish(started.script, "answer", HIGH_PROMPT, 10);
    const summary = await waitScript(chat.scripted, 2);
    summary.content("partial summary");
    for (let i = 0; i < 20; i++) {
      if (
        chat.app.runner.registry.get(started.sessionId)?.round?.content ===
        "partial summary"
      ) {
        break;
      }
      await tick();
    }
    const stopped = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/stop`,
    );
    expect(stopped.status).toBe(200);
    await settle(chat, started.sessionId);
    const stoppedRows = rows(chat, started.sessionId);
    expect(stoppedRows[1]).toMatchObject({
      kind: "reply",
      status: "done",
    });
    expect(stoppedRows[2]).toMatchObject({
      kind: "summary",
      status: "stopped",
      content: "partial summary",
      promptTokens: null,
    });
    expect(chat.app.sessions.lastSend(started.sessionId)).toMatchObject({
      status: "stopped",
      cause: "stop",
    });
    chat.app.socket.dispose();
  });

  test("an empty or failed summary fails only the summary and send", async () => {
    const emptyChat = await chatApp();
    const empty = await startChat(emptyChat);
    finish(empty.script, "answer", HIGH_PROMPT, 10);
    const emptySummary = await waitScript(emptyChat.scripted, 2);
    finish(emptySummary, "   ");
    await settle(emptyChat, empty.sessionId);
    const emptyRows = rows(emptyChat, empty.sessionId);
    expect(emptyRows[1]).toMatchObject({
      kind: "reply",
      status: "done",
      error: null,
    });
    expect(emptyRows[2]).toMatchObject({
      kind: "summary",
      status: "failed",
      error: "the summary came back empty",
    });
    expect(emptyChat.app.sessions.lastSend(empty.sessionId)).toMatchObject({
      status: "failed",
      cause: "failure",
      error: "the summary came back empty",
    });
    emptyChat.app.socket.dispose();

    const failedChat = await chatApp();
    const failed = await startChat(failedChat);
    failed.script.content("answer");
    failed.script.finish();
    failed.script.usage({ prompt: HIGH_PROMPT, completion: 10 });
    failedChat.scripted.refuse(429, '{"error":{"message":"summary failed"}}');
    failed.script.end();
    await settle(failedChat, failed.sessionId);
    const failedRows = rows(failedChat, failed.sessionId);
    expect(failedRows[1]).toMatchObject({
      kind: "reply",
      status: "done",
      error: null,
    });
    expect(failedRows[2]).toMatchObject({
      kind: "summary",
      status: "failed",
      error: 'HTTP 429: {"error":{"message":"summary failed"}}',
    });
    failedChat.app.socket.dispose();
  });

  test("compact on demand is one locked summary send", async () => {
    const chat = await chatApp();
    const started = await startChat(chat, "question");
    const locked = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/compact`,
    );
    expect(locked.status).toBe(409);
    finish(started.script, "answer");
    await settle(chat, started.sessionId);

    const first = await compact(chat, started.sessionId);
    expect(first.response.status).toBe(200);
    const detail = await first.response.json();
    expect(detail.send).toMatchObject({ kind: "compact", rounds: 1 });
    expect(first.script.body.tools).toBeUndefined();
    finish(first.script, "## Goal\n\n- First");
    await settle(chat, started.sessionId);
    expect(
      (
        await chat.member.call(
          "POST",
          `/api/sessions/${started.sessionId}/compact`,
        )
      ).status,
    ).toBe(400);

    const nextPending = chat.scripted.next();
    const sent = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/messages`,
      { body: { message: "next" } },
    );
    expect(sent.status).toBe(201);
    const next = await nextPending;
    finish(next, "next answer");
    await settle(chat, started.sessionId);
    const second = await compact(chat, started.sessionId);
    const body = second.script.body.messages as {
      role: string;
      content: string;
      name?: string;
    }[];
    expect(body.slice(1, -1)).toEqual([
      {
        role: "user",
        content: `${SUMMARY_LEAD}\n\n## Goal\n\n- First`,
      },
      { role: "user", content: "next", name: "oana" },
      { role: "assistant", content: "next answer" },
    ]);
    finish(second.script, "## Goal\n\n- Second");
    await settle(chat, started.sessionId);
    const compactSendId = chat.app.sessions.lastSend(started.sessionId)!.id;

    const regeneratePending = chat.scripted.next();
    const regenerated = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/regenerate`,
    );
    expect(regenerated.status).toBe(201);
    const replacement = await regeneratePending;
    expect(chat.app.sessions.send(compactSendId)).toBeNull();
    expect(
      chat.app.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from usage where send_id = ?",
        )
        .get(compactSendId)!.n,
    ).toBe(0);
    finish(replacement, "replacement");
    await settle(chat, started.sessionId);
    chat.app.socket.dispose();
  });

  test("an empty session has nothing to compact", async () => {
    const chat = await chatApp();
    const started = await startChat(chat);
    finish(started.script, "answer");
    await settle(chat, started.sessionId);
    chat.app.db
      .query("delete from usage where session_id = ?")
      .run(started.sessionId);
    chat.app.db
      .query("delete from messages where session_id = ?")
      .run(started.sessionId);
    chat.app.db
      .query("delete from sends where session_id = ?")
      .run(started.sessionId);
    const response = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/compact`,
    );
    expect(response.status).toBe(400);
    chat.app.socket.dispose();
  });
});
