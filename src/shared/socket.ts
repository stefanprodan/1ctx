// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The socket protocol. A durable event goes to every connection that
// may see the project and carries the session's revision; a stream
// frame goes to the connections watching that session and carries a
// sequence per send. A command is what the client sends.

import type { AutomationSummary } from "./contracts/automation.ts";
import type {
  LastLine,
  LiveSend,
  Message,
  SendSummary,
  SessionSummary,
} from "./contracts/session.ts";
import type { Role } from "./words.ts";

// bumped when a frame changes shape; a client on another protocol
// reloads the page
export const PROTOCOL = 10;

export type SocketCommand =
  | { type: "watch"; sessionId: string }
  | { type: "unwatch"; sessionId: string };

export type SocketEvent =
  | { type: "hello"; protocol: number }
  // one envelope per session transaction: the summary with its
  // revision, the rows written, the ids removed, the send row, and
  // the stream's last line when the transaction wrote one
  | {
      type: "session";
      projectId: string;
      session: SessionSummary;
      messages: Message[];
      removedMessageIds?: string[];
      send: SendSummary | null;
      last?: LastLine;
    }
  | { type: "deleted"; projectId: string; sessionId: string }
  // an automation's row after a write, by the same revision rule
  | { type: "automation"; projectId: string; automation: AutomationSummary }
  | { type: "automationDeleted"; projectId: string; automationId: string }
  // a note was written: the client refetches it when the revision is
  // above the one held
  | {
      type: "memory";
      projectId: string;
      automationId: string | null;
      revision: number;
    }
  // the connection may now see the project
  | { type: "granted"; projectId: string }
  // the connection may no longer see the project
  | { type: "revoked"; projectId: string }
  // an admin changed the user's role: the tab's user takes it
  | { type: "role"; role: Role }
  // the answer to a watch: the send in flight as far as it got
  | { type: "watched"; sessionId: string; live: LiveSend | null }
  | {
      type: "delta";
      sessionId: string;
      sendId: string;
      messageId: string;
      seq: number;
      content?: string;
      // the offset the piece belongs at
      contentAt: number;
      reasoning?: string;
      reasoningAt: number;
    }
  | {
      type: "html";
      sessionId: string;
      sendId: string;
      messageId: string;
      seq: number;
      html: string;
      // how much content the html renders
      htmlAt: number;
    };

export function isSocketCommand(value: unknown): value is SocketCommand {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.type === "watch" || v.type === "unwatch") &&
    typeof v.sessionId === "string" &&
    v.sessionId !== "" &&
    Object.keys(v).length === 2
  );
}
