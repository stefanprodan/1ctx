// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The bus events after which a session's sandboxes go: /sandbox is a
// store no clear, archive, fork or delete reads, so what they leave
// behind there must not reach the session's next command. A run's and a
// subagent's sandbox end with them, as nothing runs in either again.

import type { BusEvent } from "../lib/bus.ts";
import type { RecycleReason } from "./hold.ts";

export type Recycle = { sessionId: string; reason: RecycleReason };

// the forks seen, so a fork's later changes leave its source alone
export type SeenForks = { has(id: string): boolean; add(id: string): void };

export function recyclesOf(event: BusEvent, forks: SeenForks): Recycle[] {
  switch (event.type) {
    case "session.deleted":
      return [{ sessionId: event.data.sessionId, reason: "delete" }];
    case "child.changed":
      return event.data.child.status === "running"
        ? []
        : [{ sessionId: event.data.child.sessionId, reason: "child" }];
    case "session.changed": {
      const { session, send, cleared } = event.data;
      const out: Recycle[] = [];
      if (cleared) out.push({ sessionId: session.id, reason: "clear" });
      else if (session.archived !== null) {
        out.push({ sessionId: session.id, reason: "archive" });
      } else if (
        session.origin === "automation" &&
        send !== null &&
        send.status !== "running"
      ) {
        out.push({ sessionId: session.id, reason: "run" });
      }
      if (session.forkedFromId !== null && !forks.has(session.id)) {
        forks.add(session.id);
        out.push({ sessionId: session.forkedFromId, reason: "fork" });
      }
      return out;
    }
    default:
      return [];
  }
}

// the last forks seen, enough to tell a new one from its own changes
export function seenForks(size = 256): SeenForks {
  const ids = new Set<string>();
  return {
    has: (id) => ids.has(id),
    add(id) {
      ids.add(id);
      if (ids.size > size) ids.delete(ids.values().next().value!);
    },
  };
}
