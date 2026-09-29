// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One command per chat at a time, across all area instances, so parallel
// calls of a round never mount the same scratch revision. The held set,
// the chats holding or waiting for a command, keeps the sweep off their
// scratch.

import { Queue } from "../lib/queue.ts";

const sessions = new Map<string, Queue>();

export function heldSessions(): ReadonlySet<string> {
  return new Set(sessions.keys());
}

export async function acquireSession(
  sessionId: string,
  signal: AbortSignal,
): Promise<() => void> {
  signal.throwIfAborted();
  let queue = sessions.get(sessionId);
  if (queue === undefined) {
    queue = new Queue(1);
    sessions.set(sessionId, queue);
  }
  const release = await queue.acquire(signal);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (queue.active === 0) sessions.delete(sessionId);
  };
}
