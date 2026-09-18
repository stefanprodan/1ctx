// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { ConnData } from "../../src/server/web/socket.ts";
import type { SocketEvent } from "../../src/shared/socket.ts";
import { ORIGIN } from "../helpers/app.ts";
import { chatApp, startChat, tick, waitScript } from "../helpers/chat.ts";
import {
  call,
  type FakeConn,
  fakeTools,
  settle,
  toolRound,
  watch,
  watcher,
  write,
  writeLines,
} from "../helpers/socket-fixtures.ts";

describe("socket fixtures for delivery", () => {
  test("reconnect during tools", async () => {
    const fake = fakeTools({ c1: { hang: true } });
    const chat = await chatApp(fake);
    const first = await watcher(chat);
    const { sessionId } = await startChat(chat, "reconnect tools");
    watch(chat, first, sessionId);
    chat.scripted.scripts[0] &&
      toolRound(chat.scripted.scripts[0], [call("c1")]);
    await settle(chat, 4);
    const res = await chat.member.call("GET", `/api/sessions/${sessionId}`);
    const detail = await res.json();
    const conn = await watcher(chat);
    watch(chat, conn, sessionId);
    write("reconnect-during-tools", { kind: "fetched", detail }, conn);
    const watched = conn.frames.find((f) => f.type === "watched") as
      | Extract<SocketEvent, { type: "watched" }>
      | undefined;
    expect(watched?.live?.phase).toBe("tools");
    chat.app.socket.dispose();
  });

  test("reconnect during round 2 with a new reply id", async () => {
    const fake = fakeTools({
      c1: { result: { content: "value", error: false } },
    });
    const chat = await chatApp(fake);
    const first = await watcher(chat);
    const { detail: initial, sessionId } = await startChat(
      chat,
      "reconnect r2",
    );
    watch(chat, first, sessionId);
    toolRound(chat.scripted.scripts[0], [call("c1")]);
    await settle(chat, 4);
    const r2 = await waitScript(chat.scripted, 2);
    r2.content("answering now");
    await tick();
    await tick();
    const res = await chat.member.call("GET", `/api/sessions/${sessionId}`);
    const detail = await res.json();
    const conn = await watcher(chat);
    watch(chat, conn, sessionId);
    write("reconnect-round2", { kind: "fetched", detail }, conn);
    const watched = conn.frames.find((f) => f.type === "watched") as
      | Extract<SocketEvent, { type: "watched" }>
      | undefined;
    expect(watched?.live?.phase).toBe("reply");
    if (watched?.live?.phase === "reply") {
      expect(watched.live.messageId).not.toBe(initial.messages[1].id);
    }
    r2.finish();
    r2.usage();
    r2.end();
    await settle(chat, 8);
    chat.app.socket.dispose();
  });

  test("a stale lower-revision envelope after a full detail", async () => {
    const chat = await chatApp();
    const conn = await watcher(chat);
    const { script, sessionId } = await startChat(chat, "stale");
    watch(chat, conn, sessionId);
    script.content("Hello.");
    await tick();
    const early = conn.frames.find((f) => f.type === "session") as Extract<
      SocketEvent,
      { type: "session" }
    >;
    script.finish();
    script.usage();
    script.end();
    await settle(chat, 8);
    const res = await chat.member.call("GET", `/api/sessions/${sessionId}`);
    const finalDetail = await res.json();
    writeLines("stale-envelope", [
      { kind: "detail", detail: finalDetail },
      early,
    ]);
    expect(finalDetail.session.revision).toBeGreaterThan(
      early.session.revision,
    );
    chat.app.socket.dispose();
  });

  test("a dropped envelope then a reconnect", async () => {
    const chat = await chatApp();
    const client = chat.member;
    let captured: ConnData | null = null;
    const req = new Request(`${ORIGIN}/api/socket`, {
      headers: { cookie: client.cookie!, host: "1ctx.test", origin: ORIGIN },
    });
    await chat.app.handle(req, "127.0.0.1", (data) => {
      captured = data as ConnData;
      return true;
    });
    let calls = 0;
    const conn: FakeConn = {
      data: captured!,
      frames: [],
      closed: [],
      send(text) {
        calls += 1;
        conn.frames.push(JSON.parse(text));
        // Allow hello and watched through, then drop the first update.
        return calls >= 3 ? 0 : text.length;
      },
      close(code) {
        conn.closed.push(code ?? 1000);
      },
    };
    chat.app.socket.open(conn);
    const { sessionId } = await startChat(chat, "dropped");
    watch(chat, conn, sessionId);
    chat.scripted.scripts[0].content("partial");
    await tick();
    expect(conn.closed).toContain(1013);
    chat.scripted.scripts[0].finish();
    chat.scripted.scripts[0].usage();
    chat.scripted.scripts[0].end();
    await settle(chat, 8);
    const res = await chat.member.call("GET", `/api/sessions/${sessionId}`);
    const detail = await res.json();
    const conn2 = await watcher(chat);
    watch(chat, conn2, sessionId);
    write("dropped-then-reconnect", { kind: "fetched", detail }, conn2);
    chat.app.socket.dispose();
  });
});
