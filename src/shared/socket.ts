// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The socket protocol. A durable event goes to every connection that
// may see the project and carries the session's revision; a stream
// frame goes to the connections watching that session and carries a
// sequence per send. A command is what the client sends.

import type {
  LiveSend,
  Message,
  SendSummary,
  SessionSummary,
} from "./contracts/session.ts";

// bumped when a frame changes shape; a client on another protocol
// reloads the page
export const PROTOCOL = 3;

export type SocketCommand =
  | { type: "watch"; sessionId: string }
  | { type: "unwatch"; sessionId: string };

export type SocketEvent =
  | { type: "hello"; protocol: number }
  // one envelope per session transaction: the summary with its
  // revision, the rows written, the ids removed, and the send row
  | {
      type: "session";
      projectId: string;
      session: SessionSummary;
      messages: Message[];
      removedMessageIds?: string[];
      send: SendSummary | null;
    }
  | { type: "deleted"; projectId: string; sessionId: string }
  // the connection may no longer see the project
  | { type: "revoked"; projectId: string }
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
