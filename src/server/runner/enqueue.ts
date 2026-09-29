// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One message written to the queue of a chat whose lock is held, in one
// transaction with its bounds: the author's rows, queued and not sent,
// under queuedPerUser, the chat's under MAX_QUEUED_PER_CHAT, and a
// staged file in one queued message of the chat only.

import type { SendMessageRequest } from "../../shared/api/sessions.ts";
import type { QueuedMessage } from "../../shared/contracts/session.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, TooManyRequests } from "../lib/errors.ts";
import type { Log } from "../lib/log.ts";
import type { Limits } from "../limits/index.ts";
import {
  MAX_QUEUED_PER_CHAT,
  queueChanged,
  queuedOnWire,
  type SessionRow,
  type SessionStore,
} from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";

export type EnqueueDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  sessions: SessionStore;
  limits: { current(): Limits };
  users: { byId(id: string): UserRow | null };
  uploads: {
    checkUploads(
      userId: string,
      projectId: string,
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
): QueuedMessage {
  const queue = deps.sessions.queue;
  const user = deps.users.byId(userId);
  if (user === null) throw new BadRequest("the user is gone");
  if (fields.uploads?.length) {
    deps.uploads.checkUploads(user.id, session.projectId, fields.uploads);
  }
  const now = deps.clock();
  const queued = transact(deps.db, () => {
    const mine = queue.userCount(user.id);
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
      capabilities: fields.capabilities,
      now,
    });
    const event = queueChanged(deps.db, deps.sessions, session.id);
    return {
      result: queuedOnWire(row, user.username),
      events: event === null ? [] : [event],
    };
  });
  deps.log.info("queued", { chat: session.id, user: user.username });
  return queued;
}
