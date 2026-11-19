// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The bus events after which a session's sandboxes go: /sandbox is a
// store no clear, archive or delete reads, so what they leave behind
// there must not reach the session's next command. A run's and a
// subagent's sandbox end with them, as nothing runs in either again. A
// fork leaves its source's sandbox alone: no row ties the two.

import type { BusEvent } from "../lib/bus.ts";
import type { RecycleReason } from "./hold.ts";

export type Recycle = { sessionId: string; reason: RecycleReason };

export function recyclesOf(event: BusEvent): Recycle[] {
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
      return out;
    }
    default:
      return [];
  }
}
