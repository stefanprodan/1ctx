// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One message to a busy chat's queue (docs/queue.md, The queue).

import type {
  QueuedResponse,
  SendMessageRequest,
} from "../../shared/api/sessions.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, Conflict, TooManyRequests } from "../lib/errors.ts";
import type { Log } from "../lib/log.ts";
import type { Limits } from "../limits/index.ts";
import {
  MAX_QUEUED_PER_CHAT,
  queueAnswer,
  queuedOnWire,
  type SessionRow,
  type SessionStore,
  type SummonAgents,
  summonOf,
} from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import { CANNOT_READ_IMAGES } from "./images.ts";

export type EnqueueDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  sessions: SessionStore;
  limits: { current(): Limits };
  users: { byId(id: string): UserRow | null };
  agents: SummonAgents;
  uploads: {
    checkUploads(
      userId: string,
      projectId: string,
      ids: readonly string[],
    ): void;
  };
  images: {
    // in the enqueue's transaction: the queued row holds them
    hold(
      userId: string,
      projectId: string,
      queuedId: string,
      ids: readonly string[],
    ): void;
  };
};

const waiting = (n: number, what: string) =>
  `${what} ${n === 1 ? "1 message" : `${n} messages`} waiting`;

export function queueMessage(
  deps: EnqueueDeps,
  session: SessionRow,
  userId: string,
  fields: SendMessageRequest,
): QueuedResponse {
  const queue = deps.sessions.queue;
  const user = deps.users.byId(userId);
  if (user === null) throw new BadRequest("the user is gone");
  if (session.agentId === null) {
    throw new Conflict("a channel post cannot wait in the chat queue");
  }
  const chatAgent = deps.agents.byId(session.agentId);
  const summoned =
    chatAgent === null
      ? null
      : summonOf(deps.agents, chatAgent.name, fields.message);
  // the start checks again, against the agent as it is then
  if (fields.images?.length && !(summoned ?? chatAgent)?.images) {
    throw new BadRequest(CANNOT_READ_IMAGES);
  }
  if (fields.uploads?.length) {
    deps.uploads.checkUploads(user.id, session.projectId, fields.uploads);
  }
  const now = deps.clock();
  const queued = transact(deps.db, () => {
    const mine =
      queue.userCount(user.id) + deps.sessions.pending.userCount(user.id);
    if (mine >= deps.limits.current().queuedPerUser) {
      throw new TooManyRequests(
        `${waiting(mine, "You have")}. Send or discard one first.`,
      );
    }
    const rows = queue.waiting(session.id);
    if (rows.length >= MAX_QUEUED_PER_CHAT) {
      throw new TooManyRequests(
        `${waiting(rows.length, "This chat has")}. Try again when the reply ends.`,
      );
    }
    const taken = new Set(rows.flatMap((row) => row.uploads));
    if (fields.uploads?.some((id) => taken.has(id))) {
      throw new BadRequest("each file can be added to one message");
    }
    const row = queue.insert({
      sessionId: session.id,
      authorId: user.id,
      text: fields.message,
      uploads: fields.uploads,
      images: fields.images,
      capabilities: fields.capabilities,
      now,
    });
    if (fields.images?.length) {
      deps.images.hold(user.id, session.projectId, row.id, fields.images);
    }
    const { state, events } = queueAnswer(
      deps.db,
      deps.sessions,
      session.id,
      user.id,
      false,
    );
    return {
      result: { ...state, queued: queuedOnWire(row, user.username) },
      events,
    };
  });
  deps.log.info("queued", { chat: session.id, user: user.username });
  return queued;
}
