// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The post-commit notification bus. Events are hints: a subscriber reads
// rows when it needs the truth, no command travels here, and nothing
// durable is maintained from a listener. transact() is the only
// publisher of durable changes; it publishes after commit.

import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import type { KnowledgeFile } from "../../shared/contracts/knowledge.ts";
import type {
  LastLine,
  Message,
  SendSummary,
  SessionSummary,
} from "../../shared/contracts/session.ts";

// the event map: one entry per event, payload by name
export type BusEvents = {
  // a user's logins were revoked (logout, a password change, the
  // expiry sweep); the socket layer closes that login's connections,
  // or every connection of the user when the login id is null
  "login.revoked": { userId: string; loginId: string | null };
  // one envelope per session transaction: the summary with its
  // revision, the rows written, the ids removed, the send row, and
  // the stream's last line when the transaction wrote one
  "session.changed": {
    projectId: string;
    session: SessionSummary;
    messages: Message[];
    removedMessageIds?: string[];
    send: SendSummary | null;
    last?: LastLine;
  };
  "session.deleted": { projectId: string; sessionId: string };
  "automation.changed": {
    projectId: string;
    automation: AutomationSummary;
  };
  "automation.deleted": { projectId: string; automationId: string };
  "memory.changed": {
    projectId: string;
    automationId: string | null;
    revision: number;
  };
  "knowledge.changed": {
    projectId: string;
    file: KnowledgeFile;
    deleted: boolean;
  };
  // what these users may see changed (a membership, a role, a team
  // project made or gone); null means everyone recomputes
  "access.changed": { userIds: string[] | null };
};

export type BusEvent = {
  [K in keyof BusEvents]: { type: K; data: BusEvents[K] };
}[keyof BusEvents];

type Listener = (event: BusEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// a listener that throws is a bug in the listener, not in the publisher;
// it is reported and the others still run
export function publish(event: BusEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error(`bus: listener failed on ${event.type}: ${String(err)}`);
    }
  }
}
