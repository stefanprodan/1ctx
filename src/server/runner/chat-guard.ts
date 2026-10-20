// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Conflict } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import {
  refuseArchived,
  refuseChannel,
  type SessionRow,
} from "../sessions/index.ts";
import type { Registry } from "./registry.ts";

// a chat the principal sees that takes a turn: no run, no archive; with
// a registry, also a free lock and a chat that is not running
export function chatFor(
  deps: { visible(principal: Principal, id: string): SessionRow },
  principal: Principal,
  sessionId: string,
  verb: "continue" | "regenerate" | "compact",
  registry: Registry | null = null,
): SessionRow & { ownerId: string; agentId: string } {
  const session = deps.visible(principal, sessionId);
  refuseChannel(
    session,
    verb === "continue"
      ? "continued"
      : verb === "regenerate"
        ? "regenerated"
        : "compacted",
  );
  if (session.origin === "automation") {
    throw new Conflict(`a run cannot ${verb}`);
  }
  if (session.agentId === null || session.ownerId === null) {
    throw new Error("a chat must name its agent and owner");
  }
  refuseArchived(session);
  if (registry !== null) {
    registry.locked(session.id);
    if (session.status === "running") {
      throw new Conflict("the chat is running");
    }
  }
  return session as SessionRow & { ownerId: string; agentId: string };
}
