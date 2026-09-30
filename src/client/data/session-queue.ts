// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The queue of the chat on screen, kept by revision (queued-rows.ts): a
// detail shown, a watch's answer, a queue frame, a write's answer and
// the user's notSent event each land only where they are newer than
// what is held, with no read of their own. A start's queue frame comes
// just before the envelope that carries the user messages its rows
// became; it is held until that envelope is applied, so the rows turn
// into messages at once, never shown twice and never gone early.

import type { SessionDetail } from "../../shared/contracts/session.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import {
  partsOf,
  type QueueAt,
  type QueuePart,
  queueOnto,
} from "./queued-rows.ts";
import { session } from "./session-held.ts";

type QueueFrame = Extract<SocketEvent, { type: "queue" }>;

let at: QueueAt & { id: string } = { id: "", shared: -1, mine: -1 };
// a start's frame waiting for its envelope
let waiting: QueueFrame | null = null;

// a detail about to be shown: a whole queue at its revision, unless the
// chat held already has a newer part
export function queueShown(detail: SessionDetail): SessionDetail {
  const { id, revision } = detail.session;
  if (
    waiting !== null &&
    (waiting.sessionId !== id || waiting.revision <= revision)
  ) {
    waiting = null;
  }
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

const shared = (frame: QueueFrame) =>
  applyQueue(frame.sessionId, { revision: frame.revision, shared: frame.rows });

// every frame that carries a part of the queue; the session envelope
// after sessions.ts applied its rows
export function onQueueSocket(ev: SocketEvent): void {
  switch (ev.type) {
    case "queue": {
      const held = session.value;
      if (held === null || held.session.id !== ev.sessionId) return;
      if (ev.turn && ev.revision > held.session.revision) waiting = ev;
      else shared(ev);
      break;
    }
    case "session": {
      const frame = waiting;
      if (frame === null || frame.sessionId !== ev.session.id) return;
      if (frame.revision > ev.session.revision) return;
      waiting = null;
      // an envelope without its messages reads the detail, which brings
      // them with the queue
      if (!ev.messagesCut) shared(frame);
      break;
    }
    case "watched":
      if (ev.queue !== undefined) {
        applyQueue(ev.sessionId, {
          revision: ev.queue.revision,
          shared: ev.queue.rows,
        });
      }
      break;
    case "notSent":
      applyQueue(ev.sessionId, { revision: ev.revision, mine: ev.rows });
      break;
    default:
      break;
  }
}
