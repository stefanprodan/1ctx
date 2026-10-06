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
  type Socket,
  socketArea,
} from "../../../src/server/web/socket.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";
import { memberConn, type RecordingConn } from "../../helpers/socket.ts";

// A value that counts how often it is encoded. Counting the socket's
// own payload, not JSON.stringify, keeps other listeners on the
// process-wide bus out of the count.
type Mark = { encodes: number; toJSON(): string };
const mark = (): Mark => {
  const m: Mark = {
    encodes: 0,
    toJSON() {
      m.encodes++;
      return "mark";
    },
  };
  return m;
};

const types = (conn: RecordingConn) => conn.frames.map((frame) => frame.type);

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
    queue: () => ({ revision: 0, rows: [] }),
    children: () => [],
    ...overrides,
  });
  built.push(socket);
  return socket;
};

// each event with a mark where its frame carries a payload, and one
// more as an extra field the frame spreads in
function events(m: Mark): BusEvent[] {
  const extra = { mark: m } as object;
  return [
    {
      type: "session.changed",
      data: {
        projectId: "p",
        session: m as never,
        messages: [],
        send: null,
      },
    },
    {
      type: "session.deleted",
      data: { projectId: "p", sessionId: "gone", ...extra },
    },
    {
      type: "automation.changed",
      data: { projectId: "p", automation: m as never },
    },
    {
      type: "automation.deleted",
      data: { projectId: "p", automationId: "a", runs: true, ...extra },
    },
    {
      type: "memory.changed",
      data: { projectId: "p", automationId: null, revision: 2, ...extra },
    },
    {
      type: "knowledge.changed",
      data: { projectId: "p", file: m as never, deleted: false },
    },
    { type: "knowledge.emptied", data: { projectId: "p", ...extra } },
  ];
}

const delta = (m: Mark): SocketEvent =>
  ({
    type: "delta",
    sessionId: "s",
    sendId: "send",
    messageId: "m",
    seq: 1,
    content: "hi",
    contentAt: 0,
    reasoningAt: 0,
    mark: m,
  }) as SocketEvent;

function opened(socket: Socket, n: number): RecordingConn[] {
  const conns = Array.from({ length: n }, (_, i) => memberConn(`u${i}`, ["p"]));
  for (const conn of conns) socket.open(conn);
  for (const conn of conns) {
    conn.frames = [];
    conn.texts = [];
  }
  return conns;
}

describe("the socket fan-out", () => {
  for (const type of events(mark()).map((event) => event.type)) {
    test.serial(`${type} is encoded once for any audience`, () => {
      for (const n of [1, 5, 25]) {
        const m = mark();
        const row = mark();
        const socket = area({ envelopeRow: () => row as never });
        const conns = opened(socket, n);
        const outside = memberConn("outside", ["q"]);
        socket.open(outside);
        outside.texts = [];
        publish(events(m).find((event) => event.type === type)!);
        expect(m.encodes).toBe(1);
        expect(row.encodes).toBe(type === "session.changed" ? 1 : 0);
        for (const conn of conns) {
          expect(conn.texts).toEqual([conns[0]!.texts[0]!]);
        }
        expect(outside.texts).toEqual([]);
        socket.dispose();
      }
    });
  }

  test.serial("an event nobody may see is never encoded", () => {
    const m = mark();
    const socket = area();
    const conns = opened(socket, 3);
    conns[0]!.data.principal.mustChangePassword = true;
    conns[1]!.data.projects = new Set(["q"]);
    conns[2]!.data.projects = new Set();
    for (const event of events(m)) publish(event);
    expect(m.encodes).toBe(0);
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
      const idle = memberConn("idle", ["p"]);
      socket.open(idle);
      for (const conn of [...conns, idle]) conn.texts = [];
      const m = mark();
      socket.stream("s", delta(m));
      expect(m.encodes).toBe(1);
      for (const conn of conns) {
        expect(conn.texts).toEqual([conns[0]!.texts[0]!]);
      }
      expect(idle.texts).toEqual([]);
      const unseen = mark();
      socket.stream("nobody", delta(unseen));
      expect(unseen.encodes).toBe(0);
      socket.dispose();
    }
  });

  test.serial("hello and watched stay per connection", () => {
    const lives: Mark[] = [];
    const socket = area({
      live() {
        const m = mark();
        lives.push(m);
        return m as never;
      },
    });
    const conns = [memberConn("a", ["p"]), memberConn("b", ["p"])];
    for (const conn of conns) socket.open(conn);
    expect(conns.map(types)).toEqual([["hello"], ["hello"]]);
    socket.message(
      conns[0]!,
      JSON.stringify({ type: "watch", sessionId: "s" }),
    );
    socket.message(
      conns[1]!,
      JSON.stringify({ type: "watch", sessionId: "t" }),
    );
    // each watch takes its own snapshot and encodes it for itself
    expect(lives.map((m) => m.encodes)).toEqual([1, 1]);
    expect(conns.map(types)).toEqual([
      ["hello", "watched"],
      ["hello", "watched"],
    ]);
    expect(
      conns.map((conn) => (conn.frames[1] as { sessionId: string }).sessionId),
    ).toEqual(["s", "t"]);
    socket.dispose();
  });

  test.serial("a failed send touches only its own connection", () => {
    const socket = area();
    const [dropped, slow, fine] = opened(socket, 3) as [
      RecordingConn,
      RecordingConn,
      RecordingConn,
    ];
    for (const conn of [dropped, slow, fine]) {
      socket.message(conn, JSON.stringify({ type: "watch", sessionId: "s" }));
      conn.frames = [];
      conn.texts = [];
    }
    dropped.sendResult = 0;
    slow.sendResult = -1;
    publish(events(mark())[0]!);
    expect(dropped.closed).toEqual([
      { code: CLOSE_DROPPED, reason: "dropped a frame" },
    ]);
    expect(dropped.data.closeCause).toBe("dropped");
    expect(slow.closed).toEqual([]);
    expect(slow.data.closeCause).toBe("backpressure");
    expect(fine.closed).toEqual([]);
    expect(fine.data.closeCause).toBeUndefined();
    expect(fine.texts).toEqual(slow.texts);
    // the drop's close lands later; the others keep hearing either way
    socket.close(dropped, CLOSE_DROPPED);
    socket.stream("s", delta(mark()));
    expect(types(fine)).toEqual(["session", "delta"]);
    expect(types(slow)).toEqual(["session", "delta"]);
    socket.drain(slow);
    expect(slow.data.closeCause).toBeUndefined();
    socket.dispose();
  });

  test.serial("an author's own rows reach their connections alone", () => {
    const socket = area();
    const [author, other] = opened(socket, 2) as [RecordingConn, RecordingConn];
    const elsewhere = memberConn("u0", ["q"]);
    socket.open(elsewhere);
    elsewhere.frames = [];
    publish({
      type: "queue.mine",
      data: {
        userId: "u0",
        projectId: "p",
        sessionId: "s",
        revision: 3,
        rows: [],
      },
    });
    expect(author.frames).toEqual([
      {
        type: "notSent",
        projectId: "p",
        sessionId: "s",
        revision: 3,
        rows: [],
      },
    ]);
    expect(other.frames).toEqual([]);
    // the same user in a tab that no longer holds the project
    expect(elsewhere.frames).toEqual([]);
  });
});
