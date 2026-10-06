// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { CapabilityChange } from "../../shared/capabilities.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
import type { SendKind, SessionOrigin } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import { BadRequest } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";
import { changeNote } from "../mcp/index.ts";
import {
  type SessionRow,
  type SessionStore,
  sessionDetail,
} from "../sessions/index.ts";
import { offers, type SendPolicy } from "./policy.ts";
import type { Registry } from "./registry.ts";
import { type ActiveSend, live, newSend, type SendOp } from "./send.ts";
import { firstMessageId, type QueuedClaim, type StartFields } from "./start.ts";
import type { Writer } from "./writer.ts";

export type PreparedRun = {
  detail: SessionDetail;
  launch(): void;
  abandon(): void;
};

// admitted unless a probe, then registered; the release frees the place
// and wakes a waiter when it freed one
export function reserve(
  registry: Registry,
  wake: () => void,
  send: ActiveSend,
  admit = true,
): () => void {
  if (admit) {
    registry.admit(
      send.sessionId,
      { userId: send.startedBy, projectId: send.projectId },
      send.policy.sendCaps,
    );
  }
  registry.set(send);
  return () => {
    if (registry.free(send)) wake();
  };
}

export function logStart(
  log: Log,
  sessionId: string,
  policy: SendPolicy,
  op: SendOp,
): void {
  log.info("send start", {
    chat: sessionId,
    user: policy.username,
    agent: policy.agentName,
    provider: policy.providerName,
    model: policy.model,
    op,
  });
}

// a send starts only on a chat that is not archived, so no archive is
// read and its kept days go unused
export const startedDetail = (
  sessions: SessionStore,
  session: Parameters<typeof sessionDetail>[1],
  send: ActiveSend,
  userId: string | null,
): SessionDetail => sessionDetail(sessions, session, live(send), 0, userId);

export function prepareSend(fields: {
  db: Db;
  registry: Registry;
  // the user the send counts against, null for a scheduled run
  startedBy: string | null;
  // a freed place may let a waiting run start
  wake(): void;
  writer: Writer;
  sessions: SessionStore;
  log: Log;
  run: (send: ReturnType<typeof newSend>) => void;
  sessionId: string;
  session: SessionRow | null;
  policy: SendPolicy;
  op: SendOp;
  turn: StartFields["turn"];
  changes: readonly (CapabilityChange | undefined)[];
  // the queued messages the turn takes
  claim?: readonly QueuedClaim[];
  // a start tried in a transaction the caller rolls back: not admitted,
  // since it asks only whether the rows would start
  probe?: boolean;
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
  now: number;
}): PreparedRun {
  const now = fields.now;
  const { turn } = fields;
  const bash = offers(fields.policy.offered, "bash");
  // a regenerate reuses its rows, and their files are in the tree already
  for (const user of "users" in turn ? turn.users : []) {
    if (!user.uploads?.length) continue;
    if (fields.kind !== "chat") {
      throw new BadRequest("uploads require a new chat message");
    }
    fields.checkUploads(user.userId, fields.policy.projectId, user.uploads);
    if (!bash) {
      throw new BadRequest("this agent cannot read files");
    }
  }
  const sendId = newId();
  const replyId = newId();
  const send = newSend({
    id: sendId,
    sessionId: fields.sessionId,
    projectId: fields.policy.projectId,
    startedBy: fields.startedBy,
    kind: fields.kind,
    op: fields.op,
    policy: fields.policy,
    firstMessageId: firstMessageId(turn),
    replyId,
    now,
  });
  const release = reserve(
    fields.registry,
    fields.wake,
    send,
    fields.probe !== true,
  );
  let started: ReturnType<Writer["startSend"]>;
  try {
    // a refused start rolls the trim back with it
    started = transact(fields.db, () => {
      // under the lock, before the send is written and any command mounts:
      // the kept files trimmed to the budget stay put for the whole send
      if (bash) {
        // a regenerate's kept files go with the rows it replaces
        const kept = fields.startKept(
          fields.sessionId,
          "existing" in turn ? turn.existing.at(-1)!.seq : null,
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
      return {
        result: fields.writer.startSend({
          sendId,
          replyId,
          sessionId: fields.sessionId,
          session: fields.session,
          turn,
          origin: fields.origin,
          automationId: fields.automationId,
          kind: fields.kind,
          title: fields.title,
          policy: fields.policy,
          changes: fields.changes,
          mcpDigest: fields.policy.offered.mcpPrompt.digest,
          ...(fields.claim === undefined ? {} : { claim: fields.claim }),
        }),
        events: [],
      };
    });
    send.mcpNote = changeNote(
      started.previousMcpDigest,
      fields.policy.offered.mcpPrompt.digest,
    );
  } catch (err) {
    release();
    throw err;
  }
  let settled = false;
  let detail: SessionDetail | null = null;
  return {
    // read once, when asked: a queue's start needs none
    get detail() {
      detail ??= startedDetail(
        fields.sessions,
        started.session,
        send,
        fields.startedBy,
      );
      return detail;
    },
    launch() {
      if (settled) return;
      settled = true;
      logStart(fields.log, fields.sessionId, fields.policy, fields.op);
      fields.run(send);
    },
    abandon() {
      if (settled) return;
      settled = true;
      release();
    },
  };
}
