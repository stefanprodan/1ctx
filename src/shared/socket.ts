// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The socket protocol. A durable event goes to every connection that
// may see the project and carries the session's revision; a stream
// frame goes to the connections watching that session and carries a
// sequence per send. A command is what the client sends.

import type { EnvelopeRow } from "./api/sessions.ts";
import type { AutomationSummary } from "./contracts/automation.ts";
import type { KnowledgeFile } from "./contracts/knowledge.ts";
import type {
  ChildOf,
  LastLine,
  LiveRetry,
  LiveSend,
  Message,
  QueuedMessage,
  SendSummary,
  SessionSummary,
} from "./contracts/session.ts";
import type { Role } from "./words.ts";

// bumped when a frame changes shape; a client on another protocol
// reloads the page
export const PROTOCOL = 17;

export type VisualFrame = {
  type: "visual";
  sessionId: string;
  sendId: string;
  messageId: string;
  callIndex: number;
  seq: number;
  title?: string;
  html: string;
  // the decoded piece's offset in UTF-16 code units
  htmlAt: number;
};

// a chat's queued rows at a session revision, each text a preview
export type QueueFrame = { revision: number; rows: QueuedMessage[] };

export type SocketCommand =
  | { type: "watch"; sessionId: string }
  | { type: "unwatch"; sessionId: string };

export type SocketEvent =
  // version is the server's build: a tab that has seen another one is
  // running the client an older server shipped, and reloads the page
  | { type: "hello"; protocol: number; version: string }
  | VisualFrame
  // one envelope per session transaction: the summary with its
  // revision, the rows written, the ids removed, the send row, and
  // the feed's last line when the transaction wrote one. row is the
  // feed row as it stands after the commit, read once per event;
  // null when the session was gone by then or the read failed, which
  // the list treats alike. messagesCut: the rows written were too large
  // to carry, so a tab showing the chat reads its detail
  | {
      type: "session";
      projectId: string;
      session: SessionSummary;
      messages: Message[];
      removedMessageIds?: string[];
      send: SendSummary | null;
      last?: LastLine;
      messagesCut?: true;
      row: EnvelopeRow | null;
    }
  // to the chat's watchers alone: its queued rows, every member's, each
  // text a preview (QUEUED_PREVIEW), at the session revision of the
  // change. turn: the same commit started a turn from them, whose
  // session frame follows and carries its user messages
  | {
      type: "queue";
      sessionId: string;
      revision: number;
      turn: boolean;
      rows: QueuedMessage[];
    }
  // to the author alone: their not-sent rows in the chat after one
  // turned not sent or went, at the session revision of that change,
  // each text a preview
  | {
      type: "notSent";
      projectId: string;
      sessionId: string;
      revision: number;
      rows: QueuedMessage[];
    }
  | { type: "deleted"; projectId: string; sessionId: string }
  // an automation's row after a write, by the same revision rule
  | { type: "automation"; projectId: string; automation: AutomationSummary }
  // runs: its runs were deleted with it, every one gone at once
  | {
      type: "automationDeleted";
      projectId: string;
      automationId: string;
      runs: boolean;
    }
  // a note was written: the client refetches it when the revision is
  // above the one held
  | {
      type: "memory";
      projectId: string;
      automationId: string | null;
      revision: number;
    }
  // a knowledge file was written or deleted: the row as it is now, by
  // the same revision rule; a delete carries the last live row
  | {
      type: "knowledge";
      projectId: string;
      file: KnowledgeFile;
      deleted: boolean;
    }
  // the project's deleted files and their history are gone
  | { type: "knowledgeEmptied"; projectId: string }
  // the connection may now see the project
  | { type: "granted"; projectId: string }
  // the connection may no longer see the project
  | { type: "revoked"; projectId: string }
  // an admin changed the user's role: the tab's user takes it
  | { type: "role"; role: Role }
  // to the chat's watchers alone: a subagent's rows a transaction
  // changed, keyed by the parent's delegate row, with its status and
  // tally. Its stream deltas go nowhere
  | ({ type: "child"; sessionId: string } & ChildOf)
  // the answer to a watch: the send in flight as far as it got, the
  // queue as the queue frame carries it, and each running subagent's
  // rows so far
  | {
      type: "watched";
      sessionId: string;
      live: LiveSend | null;
      queue?: QueueFrame;
      children?: ChildOf[];
    }
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
    }
  // a round started or ended a wait to ask its provider again
  | {
      type: "retry";
      sessionId: string;
      sendId: string;
      seq: number;
      retry: LiveRetry | null;
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

export function isVisualFrame(value: unknown): value is VisualFrame {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  const id = (value: unknown) => typeof value === "string" && value !== "";
  const offset = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  return (
    v.type === "visual" &&
    id(v.sessionId) &&
    id(v.sendId) &&
    id(v.messageId) &&
    offset(v.callIndex) &&
    offset(v.seq) &&
    v.seq !== 0 &&
    offset(v.htmlAt) &&
    typeof v.html === "string" &&
    (!Object.hasOwn(v, "title") || typeof v.title === "string") &&
    Object.keys(v).every((key) =>
      [
        "type",
        "sessionId",
        "sendId",
        "messageId",
        "callIndex",
        "seq",
        "title",
        "html",
        "htmlAt",
      ].includes(key),
    )
  );
}
