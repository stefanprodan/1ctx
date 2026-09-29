// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The first transaction of a send: its rows, regeneration cleanup and
// the previous MCP snapshot the runner compares before launch.

import { type CapabilityChange, sameSet } from "../../shared/capabilities.ts";
import type { MemoryEntry } from "../../shared/contracts/memory.ts";
import type {
  Message,
  SendSummary,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import type { McpDigest } from "../../shared/mcp.ts";
import type { SendKind } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { Conflict, NotFound } from "../lib/errors.ts";
import { refuseArchived, type SessionRow } from "../sessions/index.ts";
import { envelope, lastLine } from "./envelope.ts";
import type { SendPolicy } from "./policy.ts";
import { applyChanges } from "./turn.ts";
import type { SessionsPort, UploadsPort } from "./writer-port.ts";

export type Started = {
  session: SessionSummary;
  users: Message[];
  reply: Message;
  send: SendSummary;
  previousMcpDigest: McpDigest | null;
};

export type StartUser = {
  id: string;
  userId: string;
  // the author's name, for the stream's last line
  username: string;
  text: string;
  uploads?: readonly string[];
};

export type StartFields = {
  sendId: string;
  replyId: string;
  sessionId: string;
  session: SessionRow | null;
  origin?: "chat" | "automation";
  automationId?: string | null;
  kind?: SendKind;
  turn:
    | { users: readonly StartUser[] }
    | { existing: readonly Message[]; lastAuthor: string };
  title: string;
  policy: SendPolicy;
  // applied in order, the later winning per key
  changes?: readonly (CapabilityChange | undefined)[];
  mcpDigest: McpDigest | null;
  // the queued messages the turn opens with, taken by id and revision
  claim?: readonly QueuedClaim[];
};

export type QueuedClaim = { id: string; revision: number };

// a queued message was edited or removed before its start took it, so
// the start writes nothing
export class ClaimLost extends Conflict {
  constructor() {
    super("a waiting message changed");
  }
}

export const firstMessageId = (turn: StartFields["turn"]): string =>
  "users" in turn ? turn.users[0]!.id : turn.existing[0]!.id;

export type StartDeps = {
  db: Db;
  clock: Clock;
  sessions: SessionsPort;
  uploads: UploadsPort;
  views: {
    start(sessionId: string, snapshot: readonly MemoryEntry[]): void;
    resetSeen(sessionId: string): void;
  };
};

export function startSend(deps: StartDeps, fields: StartFields): Started {
  const { policy } = fields;
  const now = deps.clock();
  return transact(deps.db, () => {
    const base = fields.session
      ? deps.sessions.byId(fields.sessionId)
      : deps.sessions.create({
          id: fields.sessionId,
          projectId: policy.projectId,
          ownerId: policy.userId,
          agentId: policy.agentId,
          origin: fields.origin,
          automationId: fields.automationId,
          runSource: policy.automation?.source ?? null,
          disabledCapabilities: policy.disabledCapabilities,
          title: fields.title,
          now,
        });
    if (base === null) throw new NotFound("no such chat");
    refuseArchived(base);
    if (fields.claim && !deps.sessions.queue.claim(base.id, fields.claim)) {
      throw new ClaimLost();
    }
    const changed = applyChanges(
      base.disabledCapabilities,
      fields.changes ?? [],
    );
    if (!sameSet(base.disabledCapabilities, changed)) {
      deps.sessions.setDisabledCapabilities(base.id, changed);
    }
    const { turn } = fields;
    const send = deps.sessions.createSend({
      id: fields.sendId,
      kind: fields.kind ?? "chat",
      sessionId: base.id,
      userId: policy.userId,
      agentId: policy.agentId,
      providerId: policy.providerId,
      model: policy.model,
      firstMessageId: firstMessageId(turn),
      mcpDigest: fields.mcpDigest,
      now,
    });
    let removedMessageIds: string[] = [];
    let users: Message[];
    let lastAuthor: string;
    if ("users" in turn) {
      const attaching = turn.users.filter((user) => user.uploads?.length);
      const claimed =
        attaching.length === 0
          ? []
          : deps.uploads.claimUploads(
              policy.projectId,
              base.id,
              attaching.map((user) => ({
                userId: user.userId,
                messageId: user.id,
                ids: user.uploads!,
              })),
            );
      const records = new Map(
        attaching.map((user, index) => [user.id, claimed[index]!]),
      );
      users = turn.users.map((user) =>
        deps.sessions.addUserMessage({
          id: user.id,
          sessionId: base.id,
          sendId: send.id,
          userId: user.userId,
          content: user.text,
          uploads: records.get(user.id) ?? null,
          now,
        }),
      );
      lastAuthor = turn.users.at(-1)!.username;
    } else {
      const replacement = deps.sessions.replaceSend(turn.existing, send.id);
      users = replacement.users;
      removedMessageIds = replacement.removedMessageIds;
      lastAuthor = turn.lastAuthor;
      // the rows that saved are gone, so the chat has seen only its snapshot
      deps.views.resetSeen(base.id);
    }
    // a chat keeps the note its first send read; a run reads it live
    if ((fields.kind ?? "chat") === "chat") {
      deps.views.start(base.id, policy.projectMemory);
    }
    const previousMcpDigest = deps.sessions.lastMcpDigest(base.id, send.id);
    const reply = deps.sessions.addReply({
      id: fields.replyId,
      sessionId: base.id,
      sendId: send.id,
      round: 1,
      agentId: policy.agentId,
      model: policy.model,
      now,
    });
    const session = deps.sessions.touch(base.id, {
      status: "running",
      now,
    })!;
    return {
      result: { session, users, reply, send, previousMcpDigest },
      events: [
        envelope(
          session,
          [...users, reply],
          send,
          removedMessageIds,
          lastLine(users.at(-1)!, lastAuthor),
        ),
      ],
    };
  });
}
