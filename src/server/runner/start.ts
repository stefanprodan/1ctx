// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The first transaction of a send: its rows, regeneration cleanup and
// the previous MCP snapshot the runner compares before launch.

import {
  applyChange,
  type CapabilityChange,
  sameSet,
} from "../../shared/capabilities.ts";
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
import { BadRequest, NotFound } from "../lib/errors.ts";
import type { SessionRow } from "../sessions/index.ts";
import { envelope, lastLine } from "./envelope.ts";
import type { SendPolicy } from "./policy.ts";
import type { SessionsPort, UploadsPort } from "./writer-port.ts";

export type Started = {
  session: SessionSummary;
  user: Message;
  reply: Message;
  send: SendSummary;
  previousMcpDigest: McpDigest | null;
};

export type StartFields = {
  sendId: string;
  replyId: string;
  userId: string;
  sessionId: string;
  session: SessionRow | null;
  origin?: "chat" | "automation";
  automationId?: string | null;
  kind?: SendKind;
  existingUser?: Message;
  title: string;
  policy: SendPolicy;
  text: string;
  uploads?: readonly string[];
  capabilities?: CapabilityChange;
  mcpDigest: McpDigest | null;
};

type StartDeps = {
  db: Db;
  clock: Clock;
  sessions: SessionsPort;
  uploads: UploadsPort;
  usage: { deleteSend(sendId: string): boolean };
  views: {
    start(sessionId: string, snapshot: readonly MemoryEntry[]): void;
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
    const changed = applyChange(base.disabledCapabilities, fields.capabilities);
    if (!changed.ok) throw new BadRequest(changed.error);
    if (!sameSet(base.disabledCapabilities, changed.set)) {
      deps.sessions.setDisabledCapabilities(base.id, changed.set);
    }
    const send = deps.sessions.createSend({
      id: fields.sendId,
      kind: fields.kind ?? "chat",
      sessionId: base.id,
      userId: policy.userId,
      agentId: policy.agentId,
      providerId: policy.providerId,
      model: policy.model,
      firstMessageId: fields.userId,
      mcpDigest: fields.mcpDigest,
      now,
    });
    let removedMessageIds: string[] = [];
    let user: Message;
    if (fields.existingUser === undefined) {
      const uploads = fields.uploads?.length
        ? deps.uploads.claimUploads(
            policy.userId,
            policy.projectId,
            base.id,
            fields.userId,
            fields.uploads,
          )
        : null;
      user = deps.sessions.addUserMessage({
        id: fields.userId,
        sessionId: base.id,
        sendId: send.id,
        userId: policy.userId,
        content: fields.text,
        uploads,
        now,
      });
    } else {
      const replacement = deps.sessions.replaceSend(
        fields.existingUser,
        send.id,
      );
      for (const sendId of replacement.removedSendIds) {
        deps.usage.deleteSend(sendId);
      }
      user = replacement.user;
      removedMessageIds = replacement.removedMessageIds;
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
      result: { session, user, reply, send, previousMcpDigest },
      events: [
        envelope(
          session,
          [user, reply],
          send,
          removedMessageIds,
          lastLine(user, policy.username),
        ),
      ],
    };
  });
}
