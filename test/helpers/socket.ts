// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A fake connection opened through the real upgrade route, so a test
// reads the frames the composed server actually sends.

import type { Conn, ConnData } from "../../src/server/web/socket.ts";
import type { SocketEvent } from "../../src/shared/socket.ts";
import { ORIGIN, type TestClient } from "./app.ts";
import type { ChatApp } from "./chat.ts";

export type FakeConn = Conn & { frames: SocketEvent[]; closed: number[] };

export async function watcher(
  chat: ChatApp,
  client: TestClient = chat.member,
): Promise<FakeConn> {
  if (client.cookie === null) throw new Error("the client is not signed in");
  let captured: ConnData | null = null;
  const req = new Request(`${ORIGIN}/api/socket`, {
    headers: { cookie: client.cookie, host: "1ctx.test", origin: ORIGIN },
  });
  await chat.app.handle(req, "127.0.0.1", (data) => {
    captured = data as ConnData;
    return true;
  });
  if (captured === null) throw new Error("the upgrade captured no data");
  const conn: FakeConn = {
    data: captured,
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
  chat.app.socket.open(conn);
  return conn;
}

export function watch(chat: ChatApp, conn: FakeConn, sessionId: string): void {
  chat.app.socket.message(conn, JSON.stringify({ type: "watch", sessionId }));
}

export function frames<T extends SocketEvent["type"]>(
  conn: FakeConn,
  type: T,
): Extract<SocketEvent, { type: T }>[] {
  return conn.frames.filter(
    (frame): frame is Extract<SocketEvent, { type: T }> => frame.type === type,
  );
}
