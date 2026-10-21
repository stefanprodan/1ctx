// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A round that loops is cut, asked again once, and a second loop fails
// the turn: through the whole app with the scripted provider.

import { describe, expect, test } from "bun:test";
import {
  groupRows,
  type WorkNode,
} from "../../../src/client/transcript/rows.ts";
import { workSummary } from "../../../src/client/transcript/Work.model.ts";
import { OUTPUT_LOOP } from "../../../src/server/runner/round-loop.ts";
import type {
  Message,
  SessionDetail,
} from "../../../src/shared/contracts/session.ts";
import { collectLogs } from "../../helpers/app.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  sessionSettled,
  startChat,
  tick,
  waitScript,
} from "../../helpers/chat.ts";
import { frames, watch, watcher } from "../../helpers/socket.ts";

// luna's recorded call: the first 20 KB of its arguments
const LUNA = await Bun.file(
  "test/fixtures/runner/repetition/luna-neeob67lsgif-head20k.txt",
).text();
// a piece from the middle of the loop, which no row may keep
const LOOPED = LUNA.slice(12_000, 12_060);

const STATUS_LINE =
  "- **Texture** : `TEXTURE_LOCAL.md` (trace creative, emergence). Pas dans un Hermes stock.\n";
const LOOP_TEXT = STATUS_LINE.repeat(250);

// the recorded call streamed in 200-character deltas
function loopInArguments(script: Script) {
  for (let at = 0; at < LUNA.length; at += 200) {
    script.toolCall({
      index: 0,
      ...(at === 0 ? { id: "call-1", name: "datetime" } : {}),
      arguments: LUNA.slice(at, at + 200),
    });
  }
}

function inPieces(text: string, send: (piece: string) => void) {
  for (let at = 0; at < text.length; at += 200) {
    send(text.slice(at, at + 200));
  }
}

const rows = (chat: ChatApp, sessionId: string): Message[] =>
  chat.app.sessions.messages(sessionId);

async function fold(chat: ChatApp, sessionId: string): Promise<string> {
  const detail: SessionDetail = await (
    await chat.member.call("GET", `/api/sessions/${sessionId}`)
  ).json();
  const turn = groupRows(detail.messages, detail.send).find(
    (node) => node.kind === "reply",
  )!;
  if (turn.kind !== "reply") throw new Error("no reply node");
  const work: WorkNode = turn.work ?? {
    sendId: turn.sendId,
    rows: [],
    rounds: [],
    answer: turn.message,
    send: turn.send,
  };
  return workSummary(work, false).text;
}

describe("a loop in call arguments", () => {
  test("is cut at 16,000 characters and the round is asked again", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    const { script, sessionId, detail } = await startChat(chat, "read it");
    const conn = await watcher(chat);
    watch(chat, conn, sessionId);
    loopInArguments(script);
    const again = await waitScript(chat.scripted, 2);
    // closing the stream lets go of it within a turn
    await tick();
    expect(script.aborted).toBe(true);
    // the same request, nothing of the cut attempt in it
    expect(again.body).toEqual(script.body);
    // the row is back where it began, empty, and the page was told
    const reply = rows(chat, sessionId).find((row) => row.kind === "reply")!;
    expect(reply).toMatchObject({
      status: "streaming",
      slot: null,
      content: "",
      reasoning: "",
    });
    expect(frames(conn, "restart")).toEqual([
      {
        type: "restart",
        sessionId,
        sendId: detail.send.id,
        messageId: reply.id,
        seq: expect.any(Number),
      },
    ]);
    const retry = { attempt: 1, max: 1, cause: "output_loop" as const };
    expect(frames(conn, "retry").map((frame) => frame.retry)).toEqual([retry]);
    expect(chat.app.runner.live(sessionId)[0]).toMatchObject({
      retry,
      content: "",
      reasoning: "",
    });
    const cut = logs.events.filter((e) => e.msg === "round loop cut");
    expect(cut).toHaveLength(1);
    expect(cut[0]).toMatchObject({ level: "warn", area: "runner" });
    expect(cut[0]!.fields).toEqual({
      chat: sessionId,
      round: 1,
      channel: "arguments",
      chars: 16_000,
    });
    again.reply("All read.");
    await sessionSettled(chat.app, sessionId);
    expect(chat.app.sessions.send(detail.send.id)!.status).toBe("done");
    // the answer's first event cleared the line
    expect(frames(conn, "retry").at(-1)!.retry).toBeNull();
    const all = rows(chat, sessionId);
    expect(JSON.stringify(all)).not.toContain(LOOPED);
    expect(all.filter((row) => row.kind === "reply")).toEqual([
      expect.objectContaining({
        id: reply.id,
        slot: "answer",
        status: "done",
        content: "All read.",
      }),
    ]);
    // a retry that answered leaves no mark on the fold
    expect(await fold(chat, sessionId)).not.toContain("loop");
    // the cut attempt counts as an estimate: its request and 16,000
    // characters streamed
    const end = logs.events.find((e) => e.msg === "send end")!;
    expect(end.fields.spent_tokens as number).toBeGreaterThan(2000);
  });

  test("twice fails the turn and no row or request keeps the loop", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    const { script, sessionId, detail } = await startChat(chat, "read it");
    loopInArguments(script);
    loopInArguments(await waitScript(chat.scripted, 2));
    await sessionSettled(chat.app, sessionId);
    expect(chat.scripted.chats()).toBe(2);
    expect(chat.app.sessions.send(detail.send.id)!).toMatchObject({
      status: "failed",
      cause: "failure",
      error: OUTPUT_LOOP,
    });
    const reply = rows(chat, sessionId).find((row) => row.kind === "reply")!;
    expect(reply).toMatchObject({
      status: "failed",
      error: "the model was stopped due to output loop",
      finishReason: "output_loop",
      content: "",
      reasoning: "",
      toolCalls: null,
    });
    expect(JSON.stringify(rows(chat, sessionId))).not.toContain(LOOPED);
    expect(await fold(chat, sessionId)).toMatch(/, output loop$/);
    expect(logs.events.filter((e) => e.msg === "round loop cut")).toHaveLength(
      2,
    );
    expect(logs.events.find((e) => e.msg === "round failed")!.fields).toEqual({
      chat: sessionId,
      round: 1,
      error_type: "Error",
      error: OUTPUT_LOOP,
    });
    // the next turn's request carries none of the looped bytes
    const next = chat.scripted.next();
    const sent = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/messages`,
      { body: { message: "try again" } },
    );
    expect(sent.status).toBeLessThan(300);
    const later = await next;
    expect(JSON.stringify(later.body)).not.toContain(LOOPED);
    expect(JSON.stringify(later.body)).toContain("try again");
    later.reply("Done.");
    await sessionSettled(chat.app, sessionId);
  });
});

describe("a loop in text", () => {
  test.each([
    ["content", (script: Script, text: string) => script.content(text)],
    ["reasoning", (script: Script, text: string) => script.reasoning(text)],
  ] as const)("a loop in %s is cut and asked again", async (channel, send) => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    const { script, sessionId, detail } = await startChat(chat, "write");
    const conn = await watcher(chat);
    watch(chat, conn, sessionId);
    inPieces(LOOP_TEXT, (piece) => send(script, piece));
    const again = await waitScript(chat.scripted, 2);
    // closing the stream lets go of it within a turn
    await tick();
    expect(script.aborted).toBe(true);
    // the page saw the loop stream, then dropped it
    const deltas = frames(conn, "delta");
    expect(deltas.length).toBeGreaterThan(0);
    expect(frames(conn, "restart")).toHaveLength(1);
    expect(frames(conn, "restart")[0]!.seq).toBeGreaterThan(deltas.at(-1)!.seq);
    expect(chat.app.runner.live(sessionId)[0]).toMatchObject({
      content: "",
      reasoning: "",
    });
    expect(
      logs.events.find((e) => e.msg === "round loop cut")!.fields,
    ).toMatchObject({ channel, chars: expect.any(Number) });
    again.reasoning("fresh thought");
    again.reply("A short answer.");
    await sessionSettled(chat.app, sessionId);
    expect(chat.app.sessions.send(detail.send.id)!.status).toBe("done");
    const reply = rows(chat, sessionId).find((row) => row.kind === "reply")!;
    expect(reply).toMatchObject({
      content: "A short answer.",
      reasoning: "fresh thought",
    });
    // the restarted attempt's deltas begin at zero again
    const after = frames(conn, "delta").filter(
      (frame) => frame.seq > frames(conn, "restart")[0]!.seq,
    );
    expect(after[0]).toMatchObject({ contentAt: 0, reasoningAt: 0 });
  });
});

describe("a loop in text twice", () => {
  test("the failed answer keeps no text and the next turn replays none", async () => {
    const chat = await chatApp();
    const { script, sessionId, detail } = await startChat(chat, "write");
    inPieces(LOOP_TEXT, (piece) => script.reasoning(piece.slice(0, 20)));
    inPieces(LOOP_TEXT, (piece) => script.content(piece));
    const again = await waitScript(chat.scripted, 2);
    again.reasoning("thinking it over");
    inPieces(LOOP_TEXT, (piece) => again.content(piece));
    await sessionSettled(chat.app, sessionId);
    expect(chat.app.sessions.send(detail.send.id)!.error).toBe(OUTPUT_LOOP);
    const reply = rows(chat, sessionId).find((row) => row.kind === "reply")!;
    expect(reply).toMatchObject({
      slot: "answer",
      status: "failed",
      finishReason: "output_loop",
      content: "",
      reasoning: "",
      html: "",
    });
    expect(JSON.stringify(rows(chat, sessionId))).not.toContain(STATUS_LINE);
    const next = chat.scripted.next();
    await chat.member.call("POST", `/api/sessions/${sessionId}/messages`, {
      body: { message: "try again" },
    });
    const later = await next;
    const body = JSON.stringify(later.body);
    expect(body).toContain("try again");
    expect(body).not.toContain("Texture");
    expect(body).not.toContain("thinking it over");
    later.reply("Done.");
    await sessionSettled(chat.app, sessionId);
  });
});

describe("a healthy long stream", () => {
  test("over 64 KB of varied text is never cut", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    const { script, sessionId, detail } = await startChat(chat, "write");
    const text = Array.from(
      { length: 1500 },
      (_, i) =>
        `| ${i} | row ${i * 7919} | status ${i % 3 === 0 ? "open" : "closed"} | the same long column for every row of the table |\n`,
    ).join("");
    expect(text.length).toBeGreaterThan(2 * 64_000);
    inPieces(text, (piece) => script.content(piece));
    script.finish("stop");
    script.usage();
    script.end();
    await sessionSettled(chat.app, sessionId);
    await tick();
    expect(chat.scripted.chats()).toBe(1);
    expect(chat.app.sessions.send(detail.send.id)!.status).toBe("done");
    const reply = rows(chat, sessionId).find((row) => row.kind === "reply")!;
    expect(reply.content).toBe(text);
    expect(logs.events.some((e) => e.msg === "round loop cut")).toBe(false);
  });
});
