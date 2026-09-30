// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A turn that opens with several user messages, each with its author,
// started as one send so the model reads them side by side before it
// acts. Each message keeps a message's own bounds.

import type { SendMessageRequest } from "../../shared/api/sessions.ts";
import {
  applyChange,
  type CapabilityChange,
} from "../../shared/capabilities.ts";
import { BadRequest } from "../lib/errors.ts";
import {
  MAX_QUEUED_PER_CHAT,
  parseSendMessage,
  type QueuedRow,
} from "../sessions/index.ts";

// the most user messages one turn opens with: a chat's whole queue
export const MAX_TURN_MESSAGES = MAX_QUEUED_PER_CHAT;

// the author by id: a message may start long after it was written, so
// the runner reads the author as they are at the start
export type TurnMessage = SendMessageRequest & { userId: string };

export function checkTurn(messages: readonly TurnMessage[]): void {
  if (messages.length === 0 || messages.length > MAX_TURN_MESSAGES) {
    throw new BadRequest(
      `a turn must open with 1 to ${MAX_TURN_MESSAGES} messages`,
    );
  }
  const seen = new Set<string>();
  for (const { message, uploads, capabilities } of messages) {
    parseSendMessage({
      message,
      ...(uploads === undefined ? {} : { uploads }),
      ...(capabilities === undefined ? {} : { capabilities }),
    });
    // a second claim of one staged file would roll the whole turn back
    for (const id of uploads ?? []) {
      if (seen.has(id)) {
        throw new BadRequest("each file can be added to one message");
      }
      seen.add(id);
    }
  }
}

// the changes one after the other, as separate sends would apply them
export function applyChanges(
  set: readonly string[],
  changes: readonly (CapabilityChange | undefined)[],
): string[] {
  let current = [...set];
  for (const change of changes) {
    const changed = applyChange(current, change);
    if (!changed.ok) throw new BadRequest(changed.error);
    current = changed.set;
  }
  return current;
}

// queued rows as the turn's messages, each by its author
export const messagesOf = (rows: readonly QueuedRow[]): TurnMessage[] =>
  rows.map((row) => ({
    userId: row.authorId,
    message: row.text,
    ...(row.uploads.length > 0 ? { uploads: row.uploads } : {}),
    ...(row.capabilities === undefined
      ? {}
      : { capabilities: row.capabilities }),
  }));

// the claim a start takes the rows with, by id and revision
export const claimsOf = (
  rows: readonly QueuedRow[],
): { id: string; revision: number }[] =>
  rows.map((row) => ({ id: row.id, revision: row.revision }));
