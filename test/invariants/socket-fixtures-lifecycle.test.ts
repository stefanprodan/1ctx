// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { compose } from "../../src/server/compose.ts";
import { silent } from "../../src/server/lib/log.ts";
import type { ConnData } from "../../src/server/web/socket.ts";
import { ORIGIN, VERSION } from "../helpers/app.ts";
import {
  type ChatApp,
  chatApp,
  startChat,
  tick,
  waitScript,
} from "../helpers/chat.ts";
import {
  call,
  type FakeConn,
  fakeTools,
  record,
  settle,
  type ToolPlan,
  toolRound,
  watch,
  watcher,
  write,
} from "../helpers/socket-fixtures.ts";

async function restart(
  name: string,
  plans: Record<string, ToolPlan>,
  build: (chat: ChatApp, sessionId: string, sendId: string) => Promise<void>,
) {
  const fake = fakeTools(plans);
  const chat = await chatApp(fake);
  const { detail, sessionId } = await startChat(chat, name);
  await build(chat, sessionId, detail.send.id);
  // The first app must not receive events from repair on the shared bus.
  chat.app.socket.dispose();
  const fresh = await compose({
    db: chat.app.db,
    secret: (kind, name) =>
      kind === "user-" && name === "user-admin" ? "hunter2-test" : null,
    clock: () => chat.app.now.value,
    fetcher: chat.scripted.fetcher,
    log: () => silent,
    version: VERSION,
    secureCookie: false,
    trustProxy: false,
    tools: fake.tools,
  });
  const detailReq = new Request(`${ORIGIN}/api/sessions/${sessionId}`, {
    headers: { cookie: chat.member.cookie!, host: "1ctx.test" },
  });
  const res = (await fresh.handle(detailReq, "127.0.0.1"))!;
  const repaired = await res.json();
  let captured: ConnData | null = null;
  const req = new Request(`${ORIGIN}/api/socket`, {
    headers: {
      cookie: chat.member.cookie!,
      host: "1ctx.test",
      origin: ORIGIN,
    },
  });
  await fresh.handle(req, "127.0.0.1", (data) => {
    captured = data as ConnData;
    return true;
  });
  const conn: FakeConn = {
    data: captured!,
    frames: [],
    closed: [],
    send(text) {
      conn.frames.push(JSON.parse(text));
      return text.length;
    },
    close(code) {
      conn.closed.push(code ?? 1000);
    },
  };
  fresh.socket.open(conn);
  fresh.socket.message(conn, JSON.stringify({ type: "watch", sessionId }));
  write(name, { kind: "fetched", detail: repaired }, conn);
  expect(fresh.sessions.send(detail.send.id)!.cause).toBe("restart");
  fresh.socket.dispose();
}

describe("socket fixtures for lifecycle", () => {
  test("stop during a work round's text after the first delta", async () => {
    const fake = fakeTools({});
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "stop text");
    watch(chat, conn, sessionId);
    script.content("thinking about a tool");
    script.toolCall(call("c1"));
    await tick();
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await settle(chat, 8);
    record("stop-work-text", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("stop");
    chat.app.socket.dispose();
  });

  test("stop after a call delta before the calls assembled", async () => {
    const fake = fakeTools({});
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "stop precall");
    watch(chat, conn, sessionId);
    script.toolCall(call("c1"));
    await tick();
    await tick();
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await settle(chat, 8);
    record("stop-after-call-delta", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("stop");
    chat.app.socket.dispose();
  });

  test("stop during a tool", async () => {
    const fake = fakeTools({ c1: { hang: true } });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "stop tool");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    await settle(chat, 4);
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await settle(chat, 8);
    record("stop-during-tool", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("stop");
    const last = conn.frames.filter((f) => f.type === "session").at(-1)!;
    expect(last.send?.cause).toBe("stop");
    expect(last.messages.map((row) => [row.kind, row.status])).toContainEqual([
      "tool",
      "stopped",
    ]);
    chat.app.socket.dispose();
  });

  test("stop during the answer", async () => {
    const fake = fakeTools({
      c1: { result: { content: "value", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "stop answer");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    const r2 = await chat.scripted.next();
    r2.content("beginning the answer");
    await tick();
    await tick();
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await settle(chat, 8);
    record("stop-during-answer", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("stop");
    chat.app.socket.dispose();
  });

  test("a provider failure in round 2 after tools", async () => {
    const fake = fakeTools({
      c1: { result: { content: "value", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "fail later");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    const r2 = await chat.scripted.next();
    r2.content("partial");
    r2.end();
    await settle(chat, 10);
    record("provider-failure-round2", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("failure");
    chat.app.socket.dispose();
  });

  test("shutdown during a tool", async () => {
    const fake = fakeTools({ c1: { hang: true } });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "shut tool");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    await settle(chat, 4);
    await chat.app.shutdown();
    record("shutdown-during-tool", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("shutdown");
  });

  test("a finalization failure after a work round", async () => {
    const fake = fakeTools({
      c1: { result: { content: "value", error: false } },
    });
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(
      chat,
      "finalize fail",
    );
    watch(chat, conn, sessionId);
    const original = chat.app.sessions.finishSend.bind(chat.app.sessions);
    (chat.app.sessions as { finishSend: unknown }).finishSend = () => {
      throw new Error("db is gone");
    };
    toolRound(script, [call("c1")]);
    const r2 = await chat.scripted.next();
    r2.reply("would answer");
    await settle(chat, 12);
    (chat.app.sessions as { finishSend: unknown }).finishSend = original;
    record("finalization-failure", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.status).toBe("running");
    chat.app.socket.dispose();
  });

  test("restart during tools", async () => {
    await restart(
      "restart-during-tools",
      { c1: { hang: true } },
      async (chat) => {
        const script = chat.scripted.scripts[0];
        toolRound(script, [call("c1")]);
        await settle(chat, 4);
      },
    );
  });

  test("restart during round 2", async () => {
    await restart(
      "restart-round2",
      { c1: { result: { content: "value", error: false } } },
      async (chat) => {
        const script = chat.scripted.scripts[0];
        toolRound(script, [call("c1")]);
        await settle(chat, 4);
        const r2 = await waitScript(chat.scripted, 2);
        r2.content("streaming round 2");
        await tick();
        await tick();
      },
    );
  });

  test("restart after tools before startRound", async () => {
    await restart(
      "restart-after-tools",
      { c1: { result: { content: "v", error: false } } },
      async (chat) => {
        // The earliest post-tool state is an empty streaming round-2 reply.
        const script = chat.scripted.scripts[0];
        toolRound(script, [call("c1")]);
        await settle(chat, 2);
      },
    );
  });
});
