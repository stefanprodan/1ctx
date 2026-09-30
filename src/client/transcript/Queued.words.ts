// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words of a message that waits: its state under it in the chat,
// and why one did not start, as a sentence there and as a short reason
// on Home's Not sent card.

import type { QueuedMessage } from "../../shared/contracts/session.ts";
import type { NotSentReason } from "../../shared/words.ts";

export const QUEUED_RUNNING = "Queued. Starts when the reply ends.";
export const QUEUED_WAITING = "Queued. Waiting for a free place.";

const WHY: Record<NotSentReason, string> = {
  expired: "It waited too long.",
  archived: "The chat was archived.",
  "agent-deleted": "Its agent was deleted.",
  failed: "It could not start.",
};

const SHORT: Record<NotSentReason, string> = {
  expired: "waited too long",
  archived: "chat archived",
  "agent-deleted": "agent deleted",
  failed: "could not start",
};

// the line under a row: queued while the chat's turn runs, or while it
// waits for a place, else why it was not sent
export function queuedLine(row: QueuedMessage, running: boolean): string {
  if (row.state === "queued") return running ? QUEUED_RUNNING : QUEUED_WAITING;
  return `Not sent. ${WHY[row.reason ?? "failed"]}`;
}

export const reasonShort = (reason: NotSentReason): string => SHORT[reason];
