// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A connection whose principal no longer refreshes leaves every set at
// once and is closed once, however late its close callback comes.

import { afterEach, expect, test } from "bun:test";
import { publish } from "../../../src/server/lib/bus.ts";
import type { Principal } from "../../../src/server/lib/http.ts";
import { silent } from "../../../src/server/lib/log.ts";
import {
  CLOSE_REVOKED,
  type Socket,
  socketArea,
} from "../../../src/server/web/socket.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";
import { memberConn } from "../../helpers/socket.ts";

const built: Socket[] = [];
afterEach(() => {
  for (const socket of built.splice(0)) socket.dispose();
});

function area() {
  const state = { signedIn: true };
  const socket = socketArea({
    version: "test",
    log: silent,
    // as the real refresh does: the ended login is published before the
    // null comes back, so the socket hears of it twice
    refresh: (principal: Principal) => {
      if (state.signedIn) return principal;
      publish({
        type: "login.revoked",
        data: { userId: principal.userId, loginId: null },
      });
      return null;
    },
    visibleProjectIds: () => (state.signedIn ? ["p"] : null),
    sessionProject: () => "p",
    live: () => [],
    envelopeRow: () => null,
    queue: () => ({ revision: 0, rows: [] }),
    children: () => [],
    drafts: () => [],
    channelMeter: () => null,
  });
  built.push(socket);
  // a close callback that lags: the socket never hears of the close
  const conn = memberConn("u-revoke", ["p"]);
  socket.open(conn);
  socket.message(conn, JSON.stringify({ type: "watch", sessionId: "s" }));
  conn.frames = [];
  return { socket, conn, state };
}

const frame = { type: "delta", sessionId: "s" } as unknown as SocketEvent;

test.serial(
  "a message after the login ended closes once and hears nothing",
  () => {
    const { socket, conn, state } = area();
    state.signedIn = false;
    socket.message(conn, JSON.stringify({ type: "unwatch", sessionId: "s" }));
    expect(conn.closed.map((c) => c.code)).toEqual([CLOSE_REVOKED]);
    expect(socket.size()).toBe(0);
    socket.stream("s", frame);
    publish({
      type: "login.revoked",
      data: { userId: "u-revoke", loginId: null },
    });
    expect(conn.frames).toEqual([]);
    expect(conn.closed).toHaveLength(1);
  },
);

test.serial(
  "a demote's access change then its login revoked close once",
  () => {
    const { socket, conn, state } = area();
    state.signedIn = false;
    publish({ type: "access.changed", data: { userIds: ["u-revoke"] } });
    expect(conn.closed.map((c) => c.code)).toEqual([CLOSE_REVOKED]);
    expect(socket.size()).toBe(0);
    socket.stream("s", frame);
    expect(conn.frames).toEqual([]);
    expect(conn.closed.map((c) => c.code)).toEqual([CLOSE_REVOKED]);
  },
);
