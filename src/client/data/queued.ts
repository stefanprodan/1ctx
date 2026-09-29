// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The author's writes to a message that waits in a chat: an edit of its
// text and a delete (Remove, Discard, Send again), each naming the
// revision it saw, so a start that took the row first answers 409. The
// answer lands on the chat on screen at once; the envelope of the same
// commit reads the detail again.

import type {
  EditQueuedRequest,
  QueuedResponse,
  RemoveQueuedRequest,
} from "../../shared/api/sessions.ts";
import type { QueuedMessage } from "../../shared/contracts/session.ts";
import { api } from "./api.ts";
import { withoutQueued, withQueued } from "./queued-rows.ts";
import { session } from "./sessions.ts";

type Seen = Pick<QueuedMessage, "id" | "revision">;

const at = (sessionId: string, id: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/queued/${encodeURIComponent(id)}`;

function put(
  sessionId: string,
  change: (rows: readonly QueuedMessage[]) => QueuedMessage[],
): void {
  const held = session.value;
  if (held === null || held.session.id !== sessionId) return;
  session.value = { ...held, queued: change(held.queued) };
}

export async function editQueued(
  sessionId: string,
  row: Seen,
  message: string,
): Promise<void> {
  const body: EditQueuedRequest = { message, revision: row.revision };
  const { queued } = await api<QueuedResponse>(
    at(sessionId, row.id),
    "PATCH",
    body,
  );
  put(sessionId, (rows) => withQueued(rows, queued));
}

export async function removeQueued(
  sessionId: string,
  row: Seen,
): Promise<void> {
  const body: RemoveQueuedRequest = { revision: row.revision };
  await api(at(sessionId, row.id), "DELETE", body);
  put(sessionId, (rows) => withoutQueued(rows, row.id));
}
