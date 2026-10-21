// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { SessionsResponse } from "../../../src/shared/api/sessions.ts";
import type {
  SendSummary,
  SessionDetail,
} from "../../../src/shared/contracts/session.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";
import { hashPassword, type TestClient } from "../../helpers/app.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  sessionSettled,
  startChat,
  waitScript,
} from "../../helpers/chat.ts";
import { createTeam } from "../../helpers/projects.ts";
import { settle, watch, watcher } from "../../helpers/socket-fixtures.ts";

const timeCall = {
  id: "time-1",
  name: "datetime",
  arguments: '{"timezone":"UTC"}',
};

// a round's usage frame with the price the provider reported, as
// OpenRouter sends it
function pricedUsage(script: Script, cost: number) {
  script.sse(
    `data: ${JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cost,
      },
    })}\n\n`,
  );
}

// one round calling the clock, then the answer, each priced when a
// cost is given
async function toolTurn(
  chat: ChatApp,
  first: Script,
  costs: [number | null, number | null],
) {
  first.toolCall({ index: 0, ...timeCall });
  first.finish("tool_calls");
  if (costs[0] === null) first.usage();
  else pricedUsage(first, costs[0]);
  first.end();
  const answer = await waitScript(chat.scripted, chat.scripted.chats() + 1);
  answer.content("It is noon.");
  answer.finish();
  if (costs[1] === null) answer.usage();
  else pricedUsage(answer, costs[1]);
  answer.end();
}

async function say(chat: ChatApp, sessionId: string, message: string) {
  const pending = chat.scripted.next();
  const response = await chat.member.call(
    "POST",
    `/api/sessions/${sessionId}/messages`,
    { body: { message } },
  );
  expect(response.status).toBe(201);
  return pending;
}

async function detail(
  client: TestClient,
  sessionId: string,
): Promise<SessionDetail> {
  const response = await client.call("GET", `/api/sessions/${sessionId}`);
  expect(response.status).toBe(200);
  return response.json();
}

// the send's tokens and cost as its usage rows hold them
function stored(chat: ChatApp, sendId: string) {
  return chat.app.db
    .query<{ rounds: number; tokens: number; cost: number | null }, [string]>(
      `select count(*) as rounds,
         sum(prompt_tokens + completion_tokens) as tokens,
         sum(cost) as cost
       from usage where send_id = ?`,
    )
    .get(sendId)!;
}

// the last envelope that carried the send ended
function endFrame(frames: SocketEvent[], sendId: string) {
  const ends = frames.filter(
    (f): f is Extract<SocketEvent, { type: "session" }> =>
      f.type === "session" &&
      f.send?.id === sendId &&
      f.send.status !== "running",
  );
  expect(ends.length).toBeGreaterThan(0);
  return ends.at(-1)!;
}

describe("a send's usage", () => {
  test("a chat's detail lists every send with its tokens and cost", async () => {
    const chat = await chatApp();
    const { script, sessionId } = await startChat(chat, "what time is it");
    await toolTurn(chat, script, [0.002, 0.0005]);
    await sessionSettled(chat.app, sessionId);

    const unpriced = await say(chat, sessionId, "thanks");
    unpriced.reply("You are welcome.");
    await sessionSettled(chat.app, sessionId);

    const mixed = await say(chat, sessionId, "and now");
    await toolTurn(chat, mixed, [0.001, null]);
    await sessionSettled(chat.app, sessionId);

    const read = await detail(chat.member, sessionId);
    expect(read.sends.map((send) => send.tokens)).toEqual([30, 15, 30]);
    const [priced, none, mix] = read.sends as [
      SendSummary,
      SendSummary,
      SendSummary,
    ];
    expect(priced.cost).toBeCloseTo(0.0025, 10);
    expect(none.cost).toBeNull();
    expect(mix.cost).toBeCloseTo(0.001, 10);
    expect(read.send).toEqual(mix);
    for (const send of read.sends) {
      expect(send.firstMessageId).toBe(
        read.messages.find(
          (row) => row.sendId === send.id && row.kind === "user",
        )!.id,
      );
    }

    // the feed's row reads the same last send
    const feed: SessionsResponse = await (
      await chat.member.call("GET", `/api/sessions?project=${chat.projectId}`)
    ).json();
    const row = feed.rows.find((r) => r.session.id === sessionId)!;
    expect(row.send?.cost).toBeCloseTo(0.001, 10);
    expect(row.send?.tokens).toBe(30);
  });

  test("a team chat's sends reach its members alone", async () => {
    const chat = await chatApp();
    const team = await createTeam(chat.admin, "research", [chat.memberId]);
    const { script, sessionId } = await startChat(
      chat,
      "what time is it",
      chat.member,
      team.id,
    );
    await toolTurn(chat, script, [0.002, 0.003]);
    await sessionSettled(chat.app, sessionId);

    const read = await detail(chat.admin, sessionId);
    expect(read.sends).toHaveLength(1);
    expect(read.sends[0]!.cost).toBeCloseTo(0.005, 10);

    chat.app.createUser({
      username: "drew",
      fullName: "Drew Roe",
      email: "drew@example.com",
      role: "member",
      passwordHash: await hashPassword("pw"),
      mustChangePassword: false,
      now: chat.app.now.value,
    });
    const outsider = chat.app.client();
    await outsider.login("drew", "pw");
    const response = await outsider.call("GET", `/api/sessions/${sessionId}`);
    expect(response.status).toBe(404);
  });

  test("a chat's end frame counts its last round", async () => {
    const chat = await chatApp();
    const conn = await watcher(chat);
    const {
      detail: started,
      script,
      sessionId,
    } = await startChat(chat, "what time is it");
    watch(chat, conn, sessionId);
    await toolTurn(chat, script, [0.002, 0.0005]);
    await settle(chat);

    const sendId = started.send.id as string;
    const rows = stored(chat, sendId);
    expect(rows.rounds).toBe(2);
    const end = endFrame(conn.frames, sendId);
    expect(end.send?.status).toBe("done");
    expect(end.send?.tokens).toBe(rows.tokens);
    expect(end.send?.tokens).toBe(30);
    expect(end.send?.cost).toBeCloseTo(0.0025, 10);
    expect(end.row?.send?.cost).toBeCloseTo(0.0025, 10);
    chat.app.socket.dispose();
  });

  test("a run's end frame counts its memory phase", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const conn = await watcher(chat);
    const { sessionId, main } = await startRun(chat, automation.id);
    watch(chat, conn, sessionId);
    main.content("The task finished.");
    main.finish();
    pricedUsage(main, 0.001);
    main.end();
    const memory = await waitScript(chat.scripted, 2);
    memory.toolCall({
      index: 0,
      id: "m1",
      name: "memory_edit",
      arguments:
        '{"action":"set","topic":"Status","text":"The task finished."}',
    });
    memory.finish("tool_calls");
    pricedUsage(memory, 0.004);
    memory.end();
    await settleRun(chat, sessionId);
    await settle(chat);

    const sendId = (await detail(chat.member, sessionId)).send!.id;
    expect(stored(chat, sendId).rounds).toBe(2);
    const end = endFrame(conn.frames, sendId);
    expect(end.send).toMatchObject({ status: "done", memoryRound: 2 });
    expect(end.send?.tokens).toBe(30);
    expect(end.send?.cost).toBeCloseTo(0.005, 10);
    chat.app.socket.dispose();
  });
});
