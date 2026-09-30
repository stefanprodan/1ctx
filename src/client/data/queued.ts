// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A message to a chat and the author's writes to one that waits. A
// message to an idle chat answers the detail; to a busy one it waits,
// answered 202 with the caller's queue. An edit and a delete (Remove,
// Discard, Send again) name the revision the row was read at, so a
// start that took it first answers 409. Every queue answer carries the
// session revision its commit made and lands only where it is newer
// than the queue held (session-queue.ts), so an answer that arrives
// after an envelope moved past it never puts a started row back.

import type {
  EditQueuedRequest,
  QueuedResponse,
  QueueState,
  RemoveQueuedRequest,
  SendMessageRequest,
  SessionResponse,
} from "../../shared/api/sessions.ts";
import type { QueuedMessage } from "../../shared/contracts/session.ts";
import { api } from "./api.ts";
import { carry, changeOf } from "./capabilities.ts";
import { partsOf } from "./queued-rows.ts";
import { applyQueue } from "./session-queue.ts";
import { sending } from "./session-start.ts";
import { take } from "./sessions.ts";

type Seen = Pick<QueuedMessage, "id" | "revision">;

const answered = (sessionId: string, state: QueueState) =>
  applyQueue(sessionId, partsOf(state.revision, state.queue));

// the flips the person made ride on the message and are forgotten once
// the server took it, as a turn or as a message that waits
export async function sendMessage(
  id: string,
  message: string,
  uploads: string[],
): Promise<void> {
  const body: SendMessageRequest = {
    message,
    ...(uploads.length === 0 ? {} : { uploads }),
    ...changeOf(id),
  };
  sending.value = true;
  try {
    const answer = await carry(id, body, () =>
      api<SessionResponse | QueuedResponse>(
        `/api/sessions/${encodeURIComponent(id)}/messages`,
        "POST",
        body,
      ),
    );
    if ("session" in answer) take(answer);
    else answered(id, answer);
  } finally {
    sending.value = false;
  }
}

const at = (sessionId: string, id: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/queued/${encodeURIComponent(id)}`;

export async function editQueued(
  sessionId: string,
  row: Seen,
  message: string,
): Promise<void> {
  const body: EditQueuedRequest = { message, revision: row.revision };
  answered(
    sessionId,
    await api<QueuedResponse>(at(sessionId, row.id), "PATCH", body),
  );
}

export async function removeQueued(
  sessionId: string,
  row: Seen,
): Promise<void> {
  const body: RemoveQueuedRequest = { revision: row.revision };
  answered(
    sessionId,
    await api<QueueState>(at(sessionId, row.id), "DELETE", body),
  );
}
