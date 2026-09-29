// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pure half of a chat's queue: a write's answer over the held rows,
// and when an envelope means the detail must be read again. A queue
// change bumps the session's revision with an envelope that carries no
// rows and changes nothing else, so an envelope that brings nothing new
// holds a change only the detail has. A turn that opens while messages
// wait took them, so its first user row reads the detail again too.

import type {
  Message,
  QueuedMessage,
  SessionDetail,
  SessionSummary,
} from "../../shared/contracts/session.ts";

// a queued row added or replaced by id, in the order the server keeps
export function withQueued(
  rows: readonly QueuedMessage[],
  row: QueuedMessage,
): QueuedMessage[] {
  const i = rows.findIndex((r) => r.id === row.id);
  if (i === -1) return [...rows, row];
  const out = rows.slice();
  out[i] = row;
  return out;
}

// the detail with the row a write answered
export const queuedOnto = (
  detail: SessionDetail,
  row: QueuedMessage,
): SessionDetail => ({ ...detail, queued: withQueued(detail.queued, row) });

export const withoutQueued = (
  rows: readonly QueuedMessage[],
  id: string,
): QueuedMessage[] => rows.filter((r) => r.id !== id);

// two JSON values alike whatever their keys' order
function alike(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    alike((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

// an envelope above the held revision: whether the detail is read again
export function queueMoved(
  held: {
    session: SessionSummary;
    messages: readonly Message[];
    queued: readonly QueuedMessage[];
  },
  ev: {
    session: SessionSummary;
    messages: readonly Message[];
    removedMessageIds?: readonly string[];
  },
): boolean {
  if (ev.messages.length === 0 && (ev.removedMessageIds ?? []).length === 0) {
    return alike(
      { ...held.session, revision: 0 },
      { ...ev.session, revision: 0 },
    );
  }
  if (!held.queued.some((q) => q.state === "queued")) return false;
  const seen = new Set(held.messages.map((m) => m.id));
  return ev.messages.some((m) => m.kind === "user" && !seen.has(m.id));
}
