// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { me } from "../../../src/client/data/me.ts";
import {
  CLOSE_RESTARTING,
  CLOSE_REVOKED,
  onSocketEvent,
  startSocket,
  type Wire,
  watch,
} from "../../../src/client/data/socket.ts";
import { PROTOCOL, type SocketEvent } from "../../../src/shared/socket.ts";

const casey = {
  id: "u1",
  username: "casey",
  fullName: "Casey",
  role: "member" as const,
  mustChangePassword: false,
};

class FakeWire implements Wire {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.closed = true;
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  fireClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

type Timer = { fn: () => void; ms: number };

let stop: (() => void) | null = null;
let offs: (() => void)[] = [];
let wires: FakeWire[] = [];
let timers: Timer[] = [];
let reloads = 0;
let pageReloads = 0;

function start(): void {
  stop = startSocket({
    connect: () => {
      const wire = new FakeWire();
      wires.push(wire);
      return wire;
    },
    reloadPage: () => {
      pageReloads++;
    },
    reload: async () => {
      reloads++;
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as Timer);
      if (index !== -1) timers.splice(index, 1);
    },
  });
}

function runTimer(): void {
  const timer = timers.shift();
  if (timer === undefined) throw new Error("no timer scheduled");
  timer.fn();
}

beforeEach(() => {
  me.value = casey;
  watch(null);
  wires = [];
  timers = [];
  reloads = 0;
  pageReloads = 0;
});

afterEach(() => {
  for (const off of offs) off();
  offs = [];
  stop?.();
  stop = null;
  me.value = undefined;
});

const hello = (version: string, protocol = PROTOCOL) =>
  JSON.stringify({ type: "hello", protocol, version });

describe("the tab socket", () => {
  test.serial(
    "opens for a signed-in user and closes when the user leaves",
    () => {
      start();
      expect(wires).toHaveLength(1);
      expect(wires[0].closed).toBe(false);

      me.value = null;

      expect(wires[0].closed).toBe(true);
    },
  );

  test.serial("a matching hello reloads data and sends the watch again", () => {
    start();
    watch("s1");
    wires[0].sent = [];

    wires[0].message(hello("v1"));

    expect(reloads).toBe(1);
    expect(pageReloads).toBe(0);
    expect(wires[0].sent).toEqual([
      JSON.stringify({ type: "watch", sessionId: "s1" }),
    ]);
  });

  test.serial("a hello for another protocol reloads the page", () => {
    start();

    wires[0].message(hello("v1", PROTOCOL + 1));

    expect(pageReloads).toBe(1);
    expect(reloads).toBe(0);
  });

  test.serial("a revoked close never reconnects and drops the user", () => {
    start();

    wires[0].fireClose(CLOSE_REVOKED);

    expect(timers).toEqual([]);
    expect(wires).toHaveLength(1);
    expect(me.value).toBeNull();
  });

  test.serial(
    "a hello from another build after a restart reloads the page",
    () => {
      start();
      wires[0].message(hello("v1+aaa"));
      wires[0].fireClose(CLOSE_RESTARTING);
      runTimer();

      wires[1].message(hello("v1+bbb"));

      expect(pageReloads).toBe(1);
      expect(reloads).toBe(1);
    },
  );

  test.serial(
    "a hello from the same build after a restart reloads only data",
    () => {
      start();
      wires[0].message(hello("v1+aaa"));
      wires[0].fireClose(CLOSE_RESTARTING);
      runTimer();

      wires[1].message(hello("v1+aaa"));

      expect(pageReloads).toBe(0);
      expect(reloads).toBe(2);
    },
  );

  test.serial("the build is kept over a sign out in the same tab", () => {
    start();
    wires[0].message(hello("v1+aaa"));
    me.value = null;
    me.value = casey;

    wires[1].message(hello("v1+bbb"));

    expect(pageReloads).toBe(1);
  });

  test.serial("a role frame gives the signed-in user the new role", () => {
    start();

    wires[0].message(JSON.stringify({ type: "role", role: "admin" }));

    expect(me.value).toEqual({ ...casey, role: "admin" });
  });

  test.serial("a restarting close schedules one retry at 2000 ms", () => {
    start();

    wires[0].fireClose(CLOSE_RESTARTING);

    expect(timers.map((timer) => timer.ms)).toEqual([2000]);
    runTimer();
    expect(wires).toHaveLength(2);
    expect(timers).toEqual([]);
  });

  test.serial("other closes back off and cap at 30000 ms", () => {
    start();
    const waits: number[] = [];

    for (let i = 0; i < 7; i++) {
      wires[i].fireClose(1006);
      waits.push(timers[0].ms);
      runTimer();
    }

    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  test.serial("watch and unwatch send commands while open", () => {
    start();

    watch("s1");
    watch(null);

    expect(wires[0].sent).toEqual([
      JSON.stringify({ type: "watch", sessionId: "s1" }),
      JSON.stringify({ type: "unwatch", sessionId: "s1" }),
    ]);
  });

  test.serial("dispatches a socket frame to registered listeners", () => {
    const seen: SocketEvent[] = [];
    offs.push(onSocketEvent((event) => seen.push(event)));
    start();
    const event = { type: "revoked", projectId: "p1" } as const;

    wires[0].message(JSON.stringify(event));

    expect(seen).toEqual([event]);
  });

  test.serial("ignores malformed JSON", () => {
    const seen: SocketEvent[] = [];
    offs.push(onSocketEvent((event) => seen.push(event)));
    start();

    wires[0].message("{");

    expect(seen).toEqual([]);
  });
});
