// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The queue of the chat on screen, kept by revision (queued-rows.ts):
// a detail shown, an envelope's queued rows, a write's answer and the
// user's notSent event each land only where they are newer than what
// is held, with no read of their own.

import type { SessionDetail } from "../../shared/contracts/session.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import {
  partsOf,
  type QueueAt,
  type QueuePart,
  queueOnto,
} from "./queued-rows.ts";
import { session } from "./session-held.ts";

let at: QueueAt & { id: string } = { id: "", shared: -1, mine: -1 };

// a detail about to be shown: a whole queue at its revision, unless the
// chat held already has a newer part
export function queueShown(detail: SessionDetail): SessionDetail {
  const { id, revision } = detail.session;
  const held = session.value;
  if (held === null || held.session.id !== id || at.id !== id) {
    at = { id, shared: revision, mine: revision };
    return detail;
  }
  const next = queueOnto(held.queued, at, partsOf(revision, detail.queued));
  if (next === null) return { ...detail, queued: held.queued };
  at = { id, ...next.at };
  return { ...detail, queued: next.queued };
}

// a part of the queue for the chat on screen
export function applyQueue(sessionId: string, part: QueuePart): void {
  const held = session.value;
  if (held === null || held.session.id !== sessionId || at.id !== sessionId) {
    return;
  }
  const next = queueOnto(held.queued, at, part);
  if (next === null) return;
  at = { id: sessionId, ...next.at };
  session.value = { ...held, queued: next.queued };
}

// an envelope's queued rows, every member's, and the user's own
// not-sent rows, which only their notSent event carries
export function onQueueSocket(ev: SocketEvent): void {
  if (ev.type === "session" && ev.queued !== undefined) {
    applyQueue(ev.session.id, {
      revision: ev.session.revision,
      shared: ev.queued,
    });
  } else if (ev.type === "notSent") {
    applyQueue(ev.sessionId, { revision: ev.revision, mine: ev.rows });
  }
}
