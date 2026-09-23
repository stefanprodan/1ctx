// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { CapabilityChange } from "../../shared/capabilities.ts";
import type { Message, SessionDetail } from "../../shared/contracts/session.ts";
import type { SendKind, SessionOrigin } from "../../shared/words.ts";
import { BadRequest } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";
import { changeNote } from "../mcp/index.ts";
import {
  type SessionRow,
  type SessionStore,
  sessionDetail,
} from "../sessions/index.ts";
import type { SendPolicy } from "./policy.ts";
import type { Pool, Registry } from "./registry.ts";
import { live, newSend, type SendOp } from "./send.ts";
import type { Writer } from "./writer.ts";

export type PreparedRun = {
  detail: SessionDetail;
  launch(): void;
  abandon(): void;
};

export function prepareSend(fields: {
  registry: Registry;
  pool: Pool;
  writer: Writer;
  sessions: SessionStore;
  log: Log;
  run: (send: ReturnType<typeof newSend>) => void;
  sessionId: string;
  session: SessionRow | null;
  policy: SendPolicy;
  op: SendOp;
  text: string;
  uploads?: readonly string[];
  capabilities?: CapabilityChange;
  checkUploads(userId: string, projectId: string, ids: readonly string[]): void;
  startKept(
    sessionId: string,
    afterSeq: number | null,
  ): {
    next: number;
    used: number;
    files: number;
    maxBytes: number;
    maxFiles: number;
  };
  title: string;
  kind: SendKind;
  origin: SessionOrigin;
  automationId: string | null;
  existingUser: Message | null;
  now: number;
}): PreparedRun {
  const now = fields.now;
  if (fields.uploads?.length) {
    if (fields.kind !== "chat" || fields.existingUser !== null) {
      throw new BadRequest("uploads require a new chat message");
    }
    fields.checkUploads(
      fields.policy.userId,
      fields.policy.projectId,
      fields.uploads,
    );
    if (!fields.policy.offered.tools.some((tool) => tool.name === "bash")) {
      throw new BadRequest("this agent cannot read files");
    }
  }
  fields.registry.admit(fields.sessionId, fields.policy.userId, fields.pool);
  const sendId = newId();
  const userId = fields.existingUser?.id ?? newId();
  const replyId = newId();
  const send = newSend({
    id: sendId,
    sessionId: fields.sessionId,
    projectId: fields.policy.projectId,
    kind: fields.kind,
    op: fields.op,
    policy: fields.policy,
    firstMessageId: userId,
    replyId,
    now,
  });
  fields.registry.set(send);
  let started: ReturnType<Writer["startSend"]>;
  try {
    // under the lock, before the send is written and any command mounts:
    // the kept files trimmed to the budget stay put for the whole send
    if (fields.policy.offered.tools.some((tool) => tool.name === "bash")) {
      // a regenerate's kept files go with the rows it replaces
      const kept = fields.startKept(
        fields.sessionId,
        fields.existingUser?.seq ?? null,
      );
      let next = kept.next;
      send.keep = {
        take: () => next++,
        maxBytes: kept.maxBytes,
        used: kept.used,
        maxFiles: kept.maxFiles,
        files: kept.files,
      };
    }
    started = fields.writer.startSend({
      sendId,
      replyId,
      userId,
      sessionId: fields.sessionId,
      session: fields.session,
      ...(fields.existingUser === null
        ? {}
        : { existingUser: fields.existingUser }),
      origin: fields.origin,
      automationId: fields.automationId,
      kind: fields.kind,
      title: fields.title,
      policy: fields.policy,
      text: fields.text,
      uploads: fields.uploads,
      capabilities: fields.capabilities,
      mcpDigest: fields.policy.offered.mcpPrompt.digest,
    });
    send.mcpNote = changeNote(
      started.previousMcpDigest,
      fields.policy.offered.mcpPrompt.digest,
    );
  } catch (err) {
    fields.registry.free(send);
    throw err;
  }
  let settled = false;
  return {
    detail: sessionDetail(fields.sessions, started.session, live(send)),
    launch() {
      if (settled) return;
      settled = true;
      fields.log.info("send start", {
        chat: fields.sessionId,
        user: fields.policy.username,
        agent: fields.policy.agentName,
        provider: fields.policy.providerName,
        model: fields.policy.model,
        op: fields.op,
      });
      fields.run(send);
    },
    abandon() {
      if (settled) return;
      settled = true;
      fields.registry.free(send);
    },
  };
}
