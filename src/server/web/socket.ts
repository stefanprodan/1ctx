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

import type { EnvelopeRow } from "../../shared/api/sessions.ts";
import type { LiveSend } from "../../shared/contracts/session.ts";
import {
  isSocketCommand,
  PROTOCOL,
  type QueueFrame,
  type SocketEvent,
} from "../../shared/socket.ts";
import { type BusEvent, subscribe } from "../lib/bus.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import { errorFields, type Log } from "../lib/log.ts";

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
  // the feed row a session envelope carries, null for a session gone
  envelopeRow(sessionId: string): EnvelopeRow | null;
  // the chat's queued rows as the queue frame carries them
  queue(sessionId: string): QueueFrame;
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
  // open connections, for tests
  size(): number;
  // the users with a connection open
  online(): number;
  onlineUserIds(): string[];
  // stop listening to the bus
  dispose(): void;
};

// a login.revoked event names this principal's login, or every login of its user
function signedOut(
  principal: Principal,
  revoked: { userId: string; loginId: string | null },
): boolean {
  return (
    principal.userId === revoked.userId &&
    (revoked.loginId === null || principal.loginId === revoked.loginId)
  );
}

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

  const revoke = (conn: Conn): void =>
    serverClose(conn, CLOSE_REVOKED, "signed out", "revoked");

  // a locked tab hears no project's events
  const sees = (conn: Conn, projectId: string): boolean =>
    !conn.data.principal.mustChangePassword &&
    conn.data.projects.has(projectId);

  const join = (map: Map<string, Set<Conn>>, key: string, conn: Conn) => {
    let set = map.get(key);
    if (set === undefined) {
      set = new Set();
      map.set(key, set);
    }
    set.add(conn);
  };

  // the principal and its visible projects now, null for a user that is gone
  const current = (
    principal: Principal,
  ): { principal: Principal; projects: string[] } | null => {
    const next = deps.refresh(principal);
    if (next === null) return null;
    const projects = deps.visibleProjectIds(next.userId);
    return projects === null ? null : { principal: next, projects };
  };

  const deliverText = (conn: Conn, text: string): void => {
    // 0 is a drop on a dead or overfull connection; -1 is backpressure
    // that Bun caps and closes past the limit
    const sent = conn.send(text);
    if (sent === 0) {
      serverClose(conn, CLOSE_DROPPED, "dropped a frame", "dropped");
    } else if (sent < 0) {
      conn.data.closeCause = "backpressure";
    }
  };

  const deliver = (conn: Conn, event: SocketEvent): void =>
    deliverText(conn, JSON.stringify(event));

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
    const now = current(conn.data.principal);
    if (now === null) {
      revoke(conn);
      return;
    }
    const { principal } = now;
    const roleChanged = principal.role !== conn.data.principal.role;
    conn.data.principal = principal;
    // the tab's user carries the role the rail and the menus read, and
    // nothing else tells it the role moved
    if (roleChanged) deliver(conn, { type: "role", role: principal.role });
    const next = new Set(now.projects);
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

  // a failed read still sends the envelope, without its row, since an
  // open chat needs the messages
  const row = (
    event: Extract<BusEvent, { type: "session.changed" }>,
  ): EnvelopeRow | null => {
    try {
      return deps.envelopeRow(event.data.session.id);
    } catch (err) {
      deps.log.error("envelope row failed", {
        chat: event.data.session.id,
        ...errorFields(err),
      });
      return null;
    }
  };

  // A durable frame goes to the connections holding its project. It is
  // built and encoded on the first connection in its audience, so an
  // event nobody may see costs neither a read nor an encoding, and one
  // seen by many tabs is encoded once; each send keeps its own result.
  const toProject = (
    projectId: string,
    frame: () => SocketEvent,
    before?: (conn: Conn) => void,
  ): void => {
    let text: string | undefined;
    each((conn) => {
      if (!sees(conn, projectId)) return;
      before?.(conn);
      text ??= JSON.stringify(frame());
      deliverText(conn, text);
    });
  };

  const onBus = (event: BusEvent): void => {
    switch (event.type) {
      case "session.changed":
        toProject(event.data.projectId, () => ({
          type: "session",
          ...event.data,
          row: row(event),
        }));
        break;
      case "queue.changed": {
        // every row's text is a preview, so the frame stays small; it goes
        // to the chat's watchers alone, as the stream frames do
        const { projectId, ...data } = event.data;
        let text: string | undefined;
        for (const conn of [...(watchers.get(data.sessionId) ?? [])]) {
          if (!sees(conn, projectId)) continue;
          text ??= JSON.stringify({ type: "queue", ...data });
          deliverText(conn, text);
        }
        break;
      }
      case "queue.mine": {
        // the author's own rows: their connections alone, and only while
        // they hold the chat's project
        const { userId, ...data } = event.data;
        let text: string | undefined;
        each((conn) => {
          if (conn.data.principal.userId !== userId) return;
          if (!sees(conn, data.projectId)) return;
          text ??= JSON.stringify({ type: "notSent", ...data });
          deliverText(conn, text);
        });
        break;
      }
      case "session.deleted":
        toProject(
          event.data.projectId,
          () => ({ type: "deleted", ...event.data }),
          (conn) => {
            if (conn.data.watching === event.data.sessionId) unwatch(conn);
          },
        );
        break;
      case "automation.changed":
        toProject(event.data.projectId, () => ({
          type: "automation",
          ...event.data,
        }));
        break;
      case "automation.deleted":
        toProject(
          event.data.projectId,
          () => ({ type: "automationDeleted", ...event.data }),
          // a run it watched may be gone with the automation
          event.data.runs ? rewatch : undefined,
        );
        break;
      case "memory.changed":
        toProject(event.data.projectId, () => ({
          type: "memory",
          ...event.data,
        }));
        break;
      case "knowledge.changed":
        toProject(event.data.projectId, () => ({
          type: "knowledge",
          ...event.data,
        }));
        break;
      case "knowledge.emptied":
        toProject(event.data.projectId, () => ({
          type: "knowledgeEmptied",
          ...event.data,
        }));
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
          const now = current(data.principal);
          if (now === null) {
            data.revoked = true;
          } else {
            data.principal = now.principal;
            data.projects = new Set(now.projects);
          }
        }
        break;
      case "login.revoked":
        each((conn) => {
          if (signedOut(conn.data.principal, event.data)) {
            // A close callback can lag behind the next committed write.
            forget(conn);
            revoke(conn);
          }
        });
        for (const data of pending) {
          if (signedOut(data.principal, event.data)) data.revoked = true;
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
        revoke(conn);
        return;
      }
      join(byUser, conn.data.principal.userId, conn);
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
        revoke(conn);
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
      join(watchers, parsed.sessionId, conn);
      // registered before the snapshot is taken, so no frame falls
      // between the two
      deliver(conn, {
        type: "watched",
        sessionId: parsed.sessionId,
        live: deps.live(parsed.sessionId),
        queue: deps.queue(parsed.sessionId),
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
      const text = JSON.stringify(frame);
      for (const conn of [...set]) deliverText(conn, text);
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
    onlineUserIds() {
      return [...byUser.keys()];
    },
    dispose() {
      unsubscribe();
      pending.clear();
    },
  };
}
