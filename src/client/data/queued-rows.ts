// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The queue a chat on screen holds, in two parts ordered by the
// session revision that last wrote each: the queued rows every member
// sees, which envelopes carry, and the user's own not-sent rows, which
// only their notSent event carries. A write's answer holds both. A part
// is taken only from a newer revision than the one held, so a write's
// answer that lands after an envelope moved past it never puts back a
// row that started, and a detail read before a change never undoes it.

import type { QueuedMessage } from "../../shared/contracts/session.ts";

export type QueueAt = { shared: number; mine: number };

export type QueuePart = {
  revision: number;
  // the queued rows, every member's
  shared?: readonly QueuedMessage[];
  // the user's not-sent rows
  mine?: readonly QueuedMessage[];
};

const waits = (row: QueuedMessage) => row.state === "queued";

// both parts as the server orders them, by when each was queued. A row
// never goes back from not sent, so the author's event, which the
// server sends before the watchers' frame of the same revision, takes
// it out of the queued part at once: drawn once, never gone between
function joined(
  shared: readonly QueuedMessage[],
  mine: readonly QueuedMessage[],
): QueuedMessage[] {
  const turned = new Set(mine.map((row) => row.id));
  return [...shared.filter((row) => !turned.has(row.id)), ...mine].sort(
    (a, b) => a.queuedAt - b.queuedAt,
  );
}

// a whole queue, a detail's or an answer's, as its two parts
export const partsOf = (
  revision: number,
  queue: readonly QueuedMessage[],
): QueuePart => ({
  revision,
  shared: queue.filter(waits),
  mine: queue.filter((row) => !waits(row)),
});

// the held queue with the newer parts of another; the revisions after
export function queueOnto(
  held: readonly QueuedMessage[],
  at: QueueAt,
  part: QueuePart,
): { queued: QueuedMessage[]; at: QueueAt } | null {
  const shared = part.shared !== undefined && part.revision > at.shared;
  const mine = part.mine !== undefined && part.revision > at.mine;
  if (!shared && !mine) return null;
  return {
    queued: joined(
      shared ? part.shared! : held.filter(waits),
      mine ? part.mine! : held.filter((row) => !waits(row)),
    ),
    at: {
      shared: shared ? part.revision : at.shared,
      mine: mine ? part.revision : at.mine,
    },
  };
}
