// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Whether a round's failed request is asked again, and after how long.
// Only a request that failed before its stream started is: a busy or
// failing server (429, 5xx, Anthropic's overloaded 529), a connection
// that failed, or a headers wait that ran out, the last only once since
// each costs two minutes.

import type { ChatEvent } from "../providers/index.ts";

export const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const RETRY_JITTER = 0.25;
export const MAX_RETRY_AFTER_MS = 30_000;
const RETRY_STATUSES: readonly number[] = [429, 500, 502, 503, 504, 529];

export type RetryState = {
  // the retries this round has made, and how many were headers waits
  retries: number;
  timeouts: number;
};

// The wait before asking again, or null when the round fails with
// these words. leftMs is the time to the turn's deadline, null for
// none; random is in [0, 1).
export function retryWait(
  event: Extract<ChatEvent, { kind: "error" }>,
  state: RetryState,
  leftMs: number | null,
  random: number,
): number | null {
  if (state.retries >= MAX_RETRIES) return null;
  if (event.unanswered) {
    if (event.timedOut && state.timeouts > 0) return null;
  } else if (
    event.status === undefined ||
    !RETRY_STATUSES.includes(event.status)
  ) {
    return null;
  }
  const after = event.retryAfterMs ?? 0;
  if (after > MAX_RETRY_AFTER_MS) return null;
  // a Retry-After only ever lengthens the backoff, and the jitter stays,
  // so sends refused together never come back at the same instant
  const base = Math.max(RETRY_BASE_MS * 2 ** state.retries, after);
  const jitter = Math.min(Math.max(random, 0), 1) * RETRY_JITTER;
  const wait = Math.round(base * (1 + jitter));
  if (leftMs !== null && wait >= leftMs) return null;
  return wait;
}
