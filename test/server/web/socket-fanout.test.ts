// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The socket's fan-out: a frame for many connections is encoded once
// and the same text reaches each; frames for one connection stay its
// own; a failed send touches only its connection.

import { afterEach, describe, expect, test } from "bun:test";
import { type BusEvent, publish } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import {
  CLOSE_DROPPED,
  type Conn,
  type Socket,
  socketArea,
} from "../../../src/server/web/socket.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";

type FakeConn = Conn & {
  texts: string[];
  closed: { code?: number; reason?: string }[];
  sendResult: number | null;
};

const fake = (userId: string, projects: string[]): FakeConn => {
  const conn: FakeConn = {
    data: {
      principal: {
        userId,
        username: userId,
        fullName: userId,
        role: "member",
        mustChangePassword: false,
        loginId: `login-${userId}`,
      },
      projects: new Set(projects),
      watching: null,
    },
    texts: [],
    closed: [],
    sendResult: null,
    send(text) {
      conn.texts.push(text);
      return conn.sendResult ?? text.length;
    },
    close(code, reason) {
      conn.closed.push({ code, reason });
    },
  };
  return conn;
};

const types = (conn: FakeConn) =>
  conn.texts.map((text) => (JSON.parse(text) as SocketEvent).type);

const built: Socket[] = [];

// a failed test still unsubscribes, or its connections would hear the
// next test's events
afterEach(() => {
  for (const socket of built.splice(0)) socket.dispose();
});

const area = (overrides: Partial<Parameters<typeof socketArea>[0]> = {}) => {
  const socket = socketArea({
    version: "test",
    log: silent,
    refresh: (principal) => principal,
    visibleProjectIds: () => ["p"],
    sessionProject: () => "p",
    live: () => null,
    envelopeRow: () => null,
    ...overrides,
  });
  built.push(socket);
  return socket;
};

// every JSON.stringify the body makes, restored even on a throw
function countStringify(body: () => void): number {
  const original = JSON.stringify;
  let calls = 0;
  JSON.stringify = ((...args: Parameters<typeof original>) => {
    calls++;
    return original(...args);
  }) as typeof original;
  try {
    body();
  } finally {
    JSON.stringify = original;
  }
  return calls;
}

const events: BusEvent[] = [
  {
    type: "session.changed",
    data: {
      projectId: "p",
      session: { id: "s", projectId: "p" } as never,
      messages: [],
      send: null,
    },
  },
  { type: "session.deleted", data: { projectId: "p", sessionId: "gone" } },
  {
    type: "automation.changed",
    data: { projectId: "p", automation: { id: "a" } as never },
  },
  {
    type: "automation.deleted",
    data: { projectId: "p", automationId: "a", runs: true },
  },
  {
    type: "memory.changed",
    data: { projectId: "p", automationId: null, revision: 2 },
  },
  {
    type: "knowledge.changed",
    data: { projectId: "p", file: { path: "a.md" } as never, deleted: false },
  },
  { type: "knowledge.emptied", data: { projectId: "p" } },
];

const delta: SocketEvent = {
  type: "delta",
  sessionId: "s",
  sendId: "send",
  messageId: "m",
  seq: 1,
  content: "hi",
  contentAt: 0,
  reasoningAt: 0,
};

function opened(socket: Socket, n: number): FakeConn[] {
  const conns = Array.from({ length: n }, (_, i) => fake(`u${i}`, ["p"]));
  for (const conn of conns) socket.open(conn);
  for (const conn of conns) conn.texts = [];
  return conns;
}

describe("the socket fan-out", () => {
  for (const event of events) {
    test.serial(`${event.type} is encoded once for any audience`, () => {
      for (const n of [1, 5, 25]) {
        const socket = area();
        const conns = opened(socket, n);
        const outside = fake("outside", ["q"]);
        socket.open(outside);
        outside.texts = [];
        expect(countStringify(() => publish(event))).toBe(1);
        for (const conn of conns) {
          expect(conn.texts).toEqual([conns[0]!.texts[0]!]);
        }
        expect(outside.texts).toEqual([]);
        socket.dispose();
      }
    });
  }

  test.serial("an event nobody may see is never encoded", () => {
    const socket = area();
    const conns = opened(socket, 3);
    conns[0]!.data.principal.mustChangePassword = true;
    conns[1]!.data.projects = new Set(["q"]);
    conns[2]!.data.projects = new Set();
    for (const event of events) {
      expect(countStringify(() => publish(event))).toBe(0);
    }
    expect(conns.flatMap((conn) => conn.texts)).toEqual([]);
    socket.dispose();
  });

  test.serial("a stream frame is encoded once for its watchers", () => {
    for (const n of [1, 5, 25]) {
      const socket = area();
      const conns = opened(socket, n);
      for (const conn of conns) {
        socket.message(conn, JSON.stringify({ type: "watch", sessionId: "s" }));
      }
      const idle = fake("idle", ["p"]);
      socket.open(idle);
      for (const conn of [...conns, idle]) conn.texts = [];
      expect(countStringify(() => socket.stream("s", delta))).toBe(1);
      for (const conn of conns)
        expect(conn.texts).toEqual([conns[0]!.texts[0]!]);
      expect(idle.texts).toEqual([]);
      expect(countStringify(() => socket.stream("nobody", delta))).toBe(0);
      socket.dispose();
    }
  });

  test.serial("hello and watched stay per connection", () => {
    const lives: string[] = [];
    const socket = area({
      live(sessionId) {
        lives.push(sessionId);
        return null;
      },
    });
    const conns = [fake("a", ["p"]), fake("b", ["p"])];
    const opens = countStringify(() => {
      for (const conn of conns) socket.open(conn);
    });
    expect(opens).toBe(2);
    expect(conns.map(types)).toEqual([["hello"], ["hello"]]);
    socket.message(
      conns[0]!,
      JSON.stringify({ type: "watch", sessionId: "s" }),
    );
    socket.message(
      conns[1]!,
      JSON.stringify({ type: "watch", sessionId: "t" }),
    );
    // each watch takes its own snapshot at its own time
    expect(lives).toEqual(["s", "t"]);
    expect(conns.map(types)).toEqual([
      ["hello", "watched"],
      ["hello", "watched"],
    ]);
    expect(conns.map((conn) => JSON.parse(conn.texts[1]!).sessionId)).toEqual([
      "s",
      "t",
    ]);
    socket.dispose();
  });

  test.serial("a failed send touches only its own connection", () => {
    const socket = area();
    const [dropped, slow, fine] = opened(socket, 3) as [
      FakeConn,
      FakeConn,
      FakeConn,
    ];
    for (const conn of [dropped, slow, fine]) {
      socket.message(conn, JSON.stringify({ type: "watch", sessionId: "s" }));
      conn.texts = [];
    }
    dropped.sendResult = 0;
    slow.sendResult = -1;
    publish(events[0]!);
    expect(dropped.closed).toEqual([
      { code: CLOSE_DROPPED, reason: "dropped a frame" },
    ]);
    expect(dropped.data.closeCause).toBe("dropped");
    expect(slow.closed).toEqual([]);
    expect(slow.data.closeCause).toBe("backpressure");
    expect(fine.closed).toEqual([]);
    expect(fine.data.closeCause).toBeUndefined();
    expect(fine.texts).toEqual(slow.texts);
    // the drop's close lands later; until then it is still in the set,
    // and the others keep hearing either way
    socket.close(dropped, CLOSE_DROPPED);
    socket.stream("s", delta);
    expect(types(fine)).toEqual(["session", "delta"]);
    expect(types(slow)).toEqual(["session", "delta"]);
    socket.drain(slow);
    expect(slow.data.closeCause).toBeUndefined();
    socket.dispose();
  });
});
