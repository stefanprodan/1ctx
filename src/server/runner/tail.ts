// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tail after a summary (docs/compaction.md, The summary and its tail).

import { compactsAt } from "../../shared/compaction.ts";
import type { Message } from "../../shared/contracts/session.ts";
import type { Wire } from "../../shared/words.ts";
import { CHARS_PER_TOKEN, tokens } from "../lib/tokens.ts";
import { type ChatMessageIn, requestText } from "../providers/index.ts";
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

// a turn's requestTokens() estimate, or null when it is over room. The
// turn before a compaction is often a huge tool result, so a text
// longer than room * CHARS_PER_TOKEN, which holds more than room tokens
// of any text but a rare one (cutToTokens()), is refused uncounted
export function costWithin(
  wire: Wire | null,
  model: string,
  messages: ChatMessageIn[],
  room: number,
): number | null {
  const text = requestText(wire, { model, messages, thinking: false });
  if (text.length > room * CHARS_PER_TOKEN) return null;
  const cost = tokens(text);
  return cost > room ? null : cost;
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
  let total = 0;
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
        : costWithin(wire, policy.model, messages, budget - total);
    if (cost === null) break;
    total += cost;
    parts.unshift(messages);
    start = begin;
  }
  return { start, messages: parts.flat(), tokens: total };
}
