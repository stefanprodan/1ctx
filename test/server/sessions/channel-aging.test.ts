// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { writeKeptFiles } from "../../../src/server/bash/index.ts";
import { DAY_MS } from "../../../src/server/lib/clock.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { trace, traceCalls } from "../../../src/server/runner/trace.ts";
import { sendTurns } from "../../../src/server/sessions/index.ts";
import { sweepChats } from "../../../src/server/sessions/sweep.ts";
import { type ChatApp, chatApp } from "../../helpers/chat.ts";

const yours = { mcp: new Set<string>(), skills: new Set<string>() };

const channelOf = (chat: ChatApp): string =>
  chat.app.db
    .query<{ id: string }, [string]>(
      "select id from sessions where project_id = ? and origin = 'channel'",
    )
    .get(chat.projectId)?.id ??
  chat.app.sessions.createChannel({
    projectId: chat.projectId,
    title: "channel",
    now: chat.app.now.value,
  }).id;

function addTurn(chat: ChatApp, channelId: string, status: "done" | "running") {
  const sendId = "turnsend0001";
  const workId = "turnwork0001";
  const bashId = "turnbash0001";
  const delegateId = "turndelg0001";
  const answerId = "turnansw0001";
  const at = chat.app.now.value - 31 * DAY_MS;
  chat.app.db
    .query(
      `insert into sends
       (id, session_id, kind, user_id, agent_id, provider_id, provider_name,
        model, status, first_message_id, rounds, tool_calls, started_at,
        finished_at)
       values (?, ?, 'chat', ?, ?, ?, 'local', 'm', ?, 'question', 1, 2,
         ?, ?)`,
    )
    .run(
      sendId,
      channelId,
      chat.memberId,
      chat.agentId,
      chat.providerId,
      status,
      at,
      status === "done" ? at + 1 : null,
    );
  const calls = [
    { id: "call-bash", name: "bash", arguments: '{"command":"echo x"}' },
    {
      id: "call-delegate",
      name: "delegate",
      arguments: '{"description":"check the api","task":"raw hidden task"}',
    },
  ];
  chat.app.db
    .query(
      `insert into messages
       (id, session_id, seq, kind, send_id, round, slot, agent_id, model,
        content, reasoning, reasoning_details, tool_calls, status, created_at,
        finished_at)
       values (?, ?, 10, 'reply', ?, 1, 'work', ?, 'm', 'working',
         'thought', '[{"type":"thinking","text":"private"}]', ?, 'done',
         ?, ?)`,
    )
    .run(
      workId,
      channelId,
      sendId,
      chat.agentId,
      JSON.stringify(calls),
      at,
      at,
    );
  const tool = chat.app.db.query(
    `insert into messages
     (id, session_id, seq, kind, send_id, round, content, reasoning,
      reasoning_details, status, tool_call_id, tool_name, created_at,
      finished_at, packed, packed_bytes, saved)
     values (?, ?, ?, 'tool', ?, 1, ?, 'tool thought', '[{"x":1}]', ?, ?, ?,
       ?, ?, ?, ?, '{"paths":["/knowledge/a.md"],"count":1,"dir":"/knowledge"}')`,
  );
  tool.run(
    bashId,
    channelId,
    11,
    sendId,
    status === "done" ? "" : "running result",
    status === "done" ? "done" : "streaming",
    "call-bash",
    "bash",
    at,
    status === "done" ? at : null,
    status === "done" ? new Uint8Array([1, 2, 3]) : null,
    status === "done" ? 123 : null,
  );
  tool.run(
    delegateId,
    channelId,
    12,
    sendId,
    "child result",
    status === "done" ? "done" : "streaming",
    "call-delegate",
    "delegate",
    at,
    status === "done" ? at : null,
    null,
    null,
  );
  chat.app.db
    .query(
      `insert into messages
       (id, session_id, seq, kind, send_id, round, slot, agent_id, model,
        content, status, created_at, finished_at)
       values (?, ?, 13, 'reply', ?, 1, 'answer', ?, 'm', 'the answer', ?, ?, ?)`,
    )
    .run(
      answerId,
      channelId,
      sendId,
      chat.agentId,
      status === "done" ? "done" : "streaming",
      at,
      status === "done" ? at : null,
    );
  return { sendId, bashId, delegateId, answerId, at };
}

describe("channel turn aging", () => {
  test("drops old tool payloads, kept files and children but preserves the trace", async () => {
    const chat = await chatApp();
    try {
      const channel = { id: channelOf(chat) };
      const turn = addTurn(chat, channel.id, "done");
      writeKeptFiles(chat.app.db, turn.bashId, [
        {
          folder: 1,
          dir: "0001-bash",
          name: "result.txt",
          text: "kept result",
          data: null,
          bytes: 11,
        },
      ]);
      const child = chat.app.sessions.create({
        projectId: chat.projectId,
        ownerId: chat.memberId,
        agentId: chat.agentId,
        origin: "channel",
        parent: { sessionId: channel.id, messageId: turn.delegateId },
        title: "check the api",
        status: "done",
        now: turn.at,
      });
      const beforeRows = chat.app.sessions
        .messages(channel.id)
        .filter((row) => row.sendId === turn.sendId);
      const before = trace(traceCalls(beforeRows), yours);
      const swept = sweepChats(
        {
          db: chat.app.db,
          store: chat.app.sessions,
          scratch: chat.app.bash.scratch,
          log: silent,
        },
        chat.app.now.value,
        DEFAULT_LIMITS,
      );
      expect(swept.turns_swept).toBe(1);
      const afterRows = chat.app.sessions
        .messages(channel.id)
        .filter((row) => row.sendId === turn.sendId);
      expect(trace(traceCalls(afterRows), yours)).toBe(before);
      expect(before).toContain("delegate check the api ok");
      const tools = afterRows.filter((row) => row.kind === "tool");
      expect(tools).toEqual(
        tools.map((row) => ({
          ...row,
          content: "",
          reasoning: "",
          resultBytes: null,
        })),
      );
      expect(
        chat.app.db
          .query("select reasoning_details, packed from messages where id = ?")
          .get(turn.bashId),
      ).toEqual({ reasoning_details: null, packed: null });
      expect(chat.app.sessions.send(turn.sendId)?.swept).toBe(true);
      expect(sendTurns(chat.app.db, channel.id).get(turn.sendId)?.swept).toBe(
        true,
      );
      expect(chat.app.sessions.message(turn.answerId)?.content).toBe(
        "the answer",
      );
      expect(
        chat.app.db
          .query(
            "select count(*) as n from mcp_kept_files where message_id = ?",
          )
          .get(turn.bashId),
      ).toEqual({ n: 0 });
      expect(chat.app.sessions.byId(child.id)).toBeNull();
      const response = await chat.member.call(
        "GET",
        `/api/sessions/${channel.id}/messages/${turn.delegateId}/child`,
      );
      expect(response.status).toBe(404);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("never touches a running old turn", async () => {
    const chat = await chatApp();
    try {
      const channelId = channelOf(chat);
      const turn = addTurn(chat, channelId, "running");
      const swept = sweepChats(
        {
          db: chat.app.db,
          store: chat.app.sessions,
          scratch: chat.app.bash.scratch,
          log: silent,
        },
        chat.app.now.value,
        DEFAULT_LIMITS,
      );
      expect(swept.turns_swept).toBe(0);
      expect(chat.app.sessions.message(turn.bashId)?.content).toBe(
        "running result",
      );
      expect(chat.app.sessions.send(turn.sendId)?.swept).toBeUndefined();
    } finally {
      await chat.app.shutdown();
    }
  });
});
