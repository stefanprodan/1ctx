// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tail: the newest whole turns before the last summary, replayed as
// they were right after it, so an exact command, error or correction
// from a minute ago is not a bullet. A turn is one send's rows but its
// summary row, so queued messages stay one turn and a call never parts
// from its result. Nothing is stored: the same rows, policy and window
// pick the same tail every turn, which keeps the provider's cached
// prefix, and a fork or a regenerate needs no migration.

import { compactsAt } from "../../shared/compaction.ts";
import type { Message } from "../../shared/contracts/session.ts";
import type { Wire } from "../../shared/words.ts";
import { type ChatMessageIn, requestTokens } from "../providers/index.ts";
import {
  type ContextLookups,
  type RenderPolicy,
  renderRows,
  type Turn,
} from "./render.ts";

export const TAIL_MAX_TOKENS = 20_000;

// the least of the cap, a tenth of the window and half of what the
// compaction threshold leaves above the request without the tail
// (base), so a small window does not compact again the turn after a
// summary; an unknown window compacts only on demand and keeps none
export function tailBudget(
  window: number | null,
  reserve: number,
  base: number,
): number {
  const threshold = compactsAt(window, reserve);
  if (window === null || threshold === null) return 0;
  return Math.max(
    0,
    Math.min(
      TAIL_MAX_TOKENS,
      Math.floor(window / 10),
      Math.floor((threshold - base) / 2),
    ),
  );
}

// the index of the last done summary before `before`, -1 for none
export function lastSummary(
  rows: readonly Message[],
  before = rows.length,
): number {
  for (let i = before - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.kind === "summary" && row.status === "done") return i;
  }
  return -1;
}

export type Tail = {
  // the index of the tail's first row, the summary's own when empty
  start: number;
  messages: ChatMessageIn[];
  tokens: number;
};

// the newest whole turns before rows[cut] whose estimate fits the
// budget. The walk stops at the first turn that does not fit, so a
// newest turn over the budget leaves the tail empty and the count never
// reads further back than the budget
export function tailOf(
  rows: readonly Message[],
  cut: number,
  budget: number,
  policy: RenderPolicy,
  lookups: ContextLookups,
  turns: ReadonlyMap<string, Turn>,
  wire: Wire | null,
): Tail {
  const parts: ChatMessageIn[][] = [];
  let tokens = 0;
  let start = cut;
  while (budget > 0 && start > 0) {
    const sendId = rows[start - 1]!.sendId;
    let begin = start - 1;
    while (begin > 0 && rows[begin - 1]!.sendId === sendId) begin--;
    const messages = renderRows(
      rows.slice(begin, start),
      policy,
      lookups,
      turns,
    );
    const cost =
      messages.length === 0
        ? 0
        : requestTokens(wire, {
            model: policy.model,
            messages,
            thinking: false,
          });
    if (tokens + cost > budget) break;
    tokens += cost;
    parts.unshift(messages);
    start = begin;
  }
  return { start, messages: parts.flat(), tokens };
}
