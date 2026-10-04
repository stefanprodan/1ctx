// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a round reads of the session's rows beyond the history, and the
// one write a provider's refusal asks for: the session's stored
// reasoning from that provider and model, dropped.

import type { Db } from "../db/index.ts";
import {
  forgetReasoning,
  type SessionStore,
  sendTurns,
} from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import type { RoundDeps } from "./round.ts";

export type LookupDeps = {
  db: Db;
  users: { byId(id: string): UserRow | null };
  sessions: Pick<SessionStore, "reasoningDetails">;
};

export function roundLookups(
  deps: LookupDeps,
): Pick<RoundDeps, "lookups" | "forgetReasoning"> {
  return {
    lookups: {
      usernameOf: (userId) => deps.users.byId(userId)?.username ?? null,
      reasoningDetailsOf: (messageId, providerId, model) =>
        deps.sessions.reasoningDetails(messageId, providerId, model),
      turnsOf: (sessionId) => sendTurns(deps.db, sessionId),
    },
    forgetReasoning: (sessionId, providerId, model) => {
      forgetReasoning(deps.db, sessionId, providerId, model);
    },
  };
}
