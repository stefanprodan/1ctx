// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The socket: every open connection by user, what each may see, and
// per-connection delivery. A durable event reaches the connections
// holding its project; a stream frame reaches the connections watching
// its session; nothing is broadcast and no Bun topic is used, so a
// slow connection is closed on its own and a revoked one stops hearing
// at once. The connection type is the few methods Bun's socket has, so
// a test drives the module with fakes.

import type { LiveSend } from "../../shared/contracts/session.ts";
import {
  isSocketCommand,
  PROTOCOL,
  type SocketEvent,
} from "../../shared/socket.ts";
import { type BusEvent, subscribe } from "../lib/bus.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";

// a frame could not be delivered: the client reconnects and reconciles
export const CLOSE_DROPPED = 1013;
// the connection's access is gone
export const CLOSE_REVOKED = 4001;
export const CLOSE_BAD_COMMAND = 4002;

export type SocketCloseCause =
  | "backpressure"
  | "dropped"
  | "revoked"
  | "shutdown"
  | "protocol";

export type ConnData = {
  principal: Principal;
  projects: Set<string>;
  watching: string | null;
  revoked: boolean;
  closeCause?: SocketCloseCause;
};

type ConnState = Omit<ConnData, "revoked"> & { revoked?: boolean };

// what the module needs of Bun's ServerWebSocket
export type Conn = {
  readonly data: ConnState;
  send(data: string): number;
  close(code?: number, reason?: string): void;
};

export type SocketDeps = {
  // the build, told to every connection so a tab left open over a
  // deploy reloads
  version: string;
  log: Log;
  // the current principal, or null for a user that is gone
  refresh(principal: Principal): Principal | null;
  // every project the user may see now, or null for a user that is gone
  visibleProjectIds(userId: string): string[] | null;
  // the session's project when the principal may see it, else null
  sessionProject(principal: Principal, sessionId: string): string | null;
  // the runner's snapshot of the send in flight
  live(sessionId: string): LiveSend | null;
};

export type Socket = {
  route: RouteDescriptor;
  open(conn: Conn): void;
  message(conn: Conn, raw: string): void;
  drain(conn: Conn): void;
  close(conn: Conn, code?: number): void;
  // a stream frame to the watchers of the session
  stream(sessionId: string, frame: SocketEvent): void;
  closeAll(code: number, reason: string): void;
  // the connections open, for a test and a log line
  size(): number;
  // the users with a connection open
  online(): number;
  // stop listening to the bus
  dispose(): void;
};

export function socketArea(deps: SocketDeps): Socket {
  const byUser = new Map<string, Set<Conn>>();
  const watchers = new Map<string, Set<Conn>>();
  const pending = new Set<ConnData>();

  const serverClose = (
    conn: Conn,
    code: number,
    reason: string,
    cause: SocketCloseCause,
  ): void => {
    conn.data.closeCause = cause;
    conn.close(code, reason);
  };

  const deliver = (conn: Conn, event: SocketEvent): void => {
    // 0 is a drop on a dead or overfull connection; -1 is backpressure
    // that Bun caps and closes past the limit
    const sent = conn.send(JSON.stringify(event));
    if (sent === 0) {
      serverClose(conn, CLOSE_DROPPED, "dropped a frame", "dropped");
    } else if (sent < 0) {
      conn.data.closeCause = "backpressure";
    }
  };

  const unwatch = (conn: Conn): void => {
    const id = conn.data.watching;
    if (id === null) return;
    conn.data.watching = null;
    const set = watchers.get(id);
    if (set === undefined) return;
    set.delete(conn);
    if (set.size === 0) watchers.delete(id);
  };

  const forget = (conn: Conn): void => {
    unwatch(conn);
    const set = byUser.get(conn.data.principal.userId);
    if (set === undefined) return;
    set.delete(conn);
    if (set.size === 0) byUser.delete(conn.data.principal.userId);
  };

  const each = (fn: (conn: Conn) => void): void => {
    for (const set of byUser.values()) for (const conn of [...set]) fn(conn);
  };

  // a watched session that is gone or out of sight is unwatched
  const rewatch = (conn: Conn): void => {
    const watching = conn.data.watching;
    if (watching !== null) {
      const project = deps.sessionProject(conn.data.principal, watching);
      if (project === null || !conn.data.projects.has(project)) unwatch(conn);
    }
  };

  // the visible set again, from the rows: a project that left it is
  // announced and unwatched, a user that is gone is closed
  const recompute = (conn: Conn): void => {
    const principal = deps.refresh(conn.data.principal);
    if (principal === null) {
      serverClose(conn, CLOSE_REVOKED, "signed out", "revoked");
      return;
    }
    const roleChanged = principal.role !== conn.data.principal.role;
    conn.data.principal = principal;
    // the tab's user carries the role the rail and the menus read, and
    // nothing else tells it the role moved
    if (roleChanged) deliver(conn, { type: "role", role: principal.role });
    const ids = deps.visibleProjectIds(principal.userId);
    if (ids === null) {
      serverClose(conn, CLOSE_REVOKED, "signed out", "revoked");
      return;
    }
    const next = new Set(ids);
    for (const id of conn.data.projects) {
      if (next.has(id)) continue;
      conn.data.projects.delete(id);
      deliver(conn, { type: "revoked", projectId: id });
    }
    for (const id of next) {
      if (conn.data.projects.has(id)) continue;
      conn.data.projects.add(id);
      deliver(conn, { type: "granted", projectId: id });
    }
    rewatch(conn);
  };

  const onBus = (event: BusEvent): void => {
    switch (event.type) {
      case "session.changed":
        each((conn) => {
          if (
            !conn.data.principal.mustChangePassword &&
            conn.data.projects.has(event.data.projectId)
          ) {
            deliver(conn, { type: "session", ...event.data });
          }
        });
        break;
      case "session.deleted":
        each((conn) => {
          if (
            !conn.data.principal.mustChangePassword &&
            conn.data.projects.has(event.data.projectId)
          ) {
            if (conn.data.watching === event.data.sessionId) unwatch(conn);
            deliver(conn, { type: "deleted", ...event.data });
          }
        });
        break;
      case "automation.changed":
        each((conn) => {
          if (
            !conn.data.principal.mustChangePassword &&
            conn.data.projects.has(event.data.projectId)
          ) {
            deliver(conn, { type: "automation", ...event.data });
          }
        });
        break;
      case "automation.deleted":
        each((conn) => {
          if (
            !conn.data.principal.mustChangePassword &&
            conn.data.projects.has(event.data.projectId)
          ) {
            // a run it watched may be gone with the automation
            if (event.data.runs) rewatch(conn);
            deliver(conn, { type: "automationDeleted", ...event.data });
          }
        });
        break;
      case "memory.changed":
        each((conn) => {
          if (
            !conn.data.principal.mustChangePassword &&
            conn.data.projects.has(event.data.projectId)
          ) {
            deliver(conn, { type: "memory", ...event.data });
          }
        });
        break;
      case "knowledge.changed":
        each((conn) => {
          if (
            !conn.data.principal.mustChangePassword &&
            conn.data.projects.has(event.data.projectId)
          ) {
            deliver(conn, { type: "knowledge", ...event.data });
          }
        });
        break;
      case "knowledge.emptied":
        each((conn) => {
          if (
            !conn.data.principal.mustChangePassword &&
            conn.data.projects.has(event.data.projectId)
          ) {
            deliver(conn, { type: "knowledgeEmptied", ...event.data });
          }
        });
        break;
      case "access.changed":
        each((conn) => {
          const ids = event.data.userIds;
          if (ids === null || ids.includes(conn.data.principal.userId)) {
            recompute(conn);
          }
        });
        for (const data of pending) {
          const ids = event.data.userIds;
          if (ids !== null && !ids.includes(data.principal.userId)) continue;
          const principal = deps.refresh(data.principal);
          const projects =
            principal === null
              ? null
              : deps.visibleProjectIds(principal.userId);
          if (principal === null || projects === null) {
            data.revoked = true;
          } else {
            data.principal = principal;
            data.projects = new Set(projects);
          }
        }
        break;
      case "login.revoked":
        each((conn) => {
          const p = conn.data.principal;
          if (
            p.userId === event.data.userId &&
            (event.data.loginId === null || p.loginId === event.data.loginId)
          ) {
            // A close callback can lag behind the next committed write.
            forget(conn);
            serverClose(conn, CLOSE_REVOKED, "signed out", "revoked");
          }
        });
        for (const data of pending) {
          const p = data.principal;
          if (
            p.userId === event.data.userId &&
            (event.data.loginId === null || p.loginId === event.data.loginId)
          ) {
            data.revoked = true;
          }
        }
        break;
    }
  };
  const unsubscribe = subscribe(onBus, deps.log);

  return {
    route: {
      method: "GET",
      path: "/api/socket",
      policy: "authenticated",
      passwordChange: true,
      upgrade: true,
      handle(_req, ctx) {
        const principal = ctx.principal!;
        const data: ConnData = {
          principal,
          projects: new Set(deps.visibleProjectIds(principal.userId) ?? []),
          watching: null,
          revoked: false,
        };
        pending.add(data);
        // no upgrader (the test harness), or a request that is not a
        // websocket handshake: the same answer
        if (ctx.upgrade?.(data)) return undefined;
        pending.delete(data);
        return json({ error: "upgrade required" }, 426);
      },
    },
    open(conn) {
      pending.delete(conn.data as ConnData);
      deps.log.info("socket open", {
        user: conn.data.principal.username,
      });
      if (conn.data.revoked === true) {
        serverClose(conn, CLOSE_REVOKED, "signed out", "revoked");
        return;
      }
      let set = byUser.get(conn.data.principal.userId);
      if (set === undefined) {
        set = new Set();
        byUser.set(conn.data.principal.userId, set);
      }
      set.add(conn);
      deliver(conn, {
        type: "hello",
        protocol: PROTOCOL,
        version: deps.version,
      });
    },
    message(conn, raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (!isSocketCommand(parsed)) {
        serverClose(conn, CLOSE_BAD_COMMAND, "bad command", "protocol");
        return;
      }
      const principal = deps.refresh(conn.data.principal);
      if (principal === null) {
        serverClose(conn, CLOSE_REVOKED, "signed out", "revoked");
        return;
      }
      conn.data.principal = principal;
      if (parsed.type === "unwatch") {
        if (conn.data.watching === parsed.sessionId) unwatch(conn);
        return;
      }
      // The socket stays open so revocation reaches a locked tab, but it must
      // not become a route around the password-change gate.
      if (principal.mustChangePassword) return;
      const project = deps.sessionProject(principal, parsed.sessionId);
      if (project === null || !conn.data.projects.has(project)) return;
      unwatch(conn);
      conn.data.watching = parsed.sessionId;
      let set = watchers.get(parsed.sessionId);
      if (set === undefined) {
        set = new Set();
        watchers.set(parsed.sessionId, set);
      }
      set.add(conn);
      // registered before the snapshot is taken, so no frame falls
      // between the two
      deliver(conn, {
        type: "watched",
        sessionId: parsed.sessionId,
        live: deps.live(parsed.sessionId),
      });
    },
    drain(conn) {
      if (conn.data.closeCause === "backpressure") {
        conn.data.closeCause = undefined;
      }
    },
    close(conn, code = 1000) {
      forget(conn);
      deps.log.info("socket close", {
        user: conn.data.principal.username,
        code,
        cause: conn.data.closeCause,
      });
    },
    stream(sessionId, frame) {
      const set = watchers.get(sessionId);
      if (set === undefined) return;
      for (const conn of [...set]) deliver(conn, frame);
    },
    closeAll(code, reason) {
      each((conn) => serverClose(conn, code, reason, "shutdown"));
    },
    size() {
      let n = 0;
      for (const set of byUser.values()) n += set.size;
      return n;
    },
    online() {
      return byUser.size;
    },
    dispose() {
      unsubscribe();
      pending.clear();
    },
  };
}
