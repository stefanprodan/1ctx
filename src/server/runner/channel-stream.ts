// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message } from "../../shared/contracts/session.ts";
import { tokens } from "../lib/tokens.ts";
import type { ChatMessageIn } from "../providers/index.ts";
import type { ChannelRow, ChannelTurn } from "./channel-read.ts";
import {
  type ContextLookups,
  foreignTurn,
  type RenderPolicy,
  userMessage,
} from "./render.ts";
import { trace, traceCalls, type Yours } from "./trace.ts";

export type StreamTurn = {
  id: string;
  seq: number;
  rows: ChannelRow[];
  turn: ChannelTurn | undefined;
  tokens: number;
};

export function channelLookups(
  rows: readonly ChannelRow[],
  turns: ReadonlyMap<string, ChannelTurn>,
): ContextLookups {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const names = new Map(rows.map((row) => [row.userId, row.username]));
  return {
    usernameOf: (id) => names.get(id) ?? null,
    turnsOf: () => turns,
    reasoningDetailsOf(id, provider, model) {
      const row = byId.get(id);
      return row?.model === model &&
        turns.get(row.sendId)?.providerId === provider
        ? row.details
        : null;
    },
  };
}

function posts(
  rows: readonly Message[],
  lookups: ContextLookups,
): ChatMessageIn[] {
  return rows
    .filter((row) => row.kind === "user")
    .map((row) => userMessage(row, { userId: "", username: "" }, lookups));
}

export function tracedTurn(
  part: StreamTurn,
  lookups: ContextLookups,
  yours: Yours | null,
  own = false,
): ChatMessageIn[] {
  const out = posts(part.rows, lookups);
  if (part.turn === undefined) return out;
  if (!own) return [...out, ...foreignTurn(part.turn, part.rows, yours)];
  const calls = trace(traceCalls(part.rows), yours);
  if (calls !== "") out.push({ role: "user", content: calls });
  for (const row of part.rows) {
    if (
      row.kind === "reply" &&
      row.slot !== "work" &&
      row.status !== "streaming" &&
      row.content !== ""
    ) {
      out.push({
        role: "assistant",
        model: row.model ?? undefined,
        content: row.content,
      });
    }
  }
  return out;
}

// The post belongs to a post send, but first_message_id joins it to the
// turn it summoned. Map insertion order alone cannot order interleaved turns.
export function streamTurns(
  rows: ChannelRow[],
  turns: ReadonlyMap<string, ChannelTurn>,
): StreamTurn[] {
  const summoned = new Map(
    [...turns].map(([id, turn]) => [turn.firstMessageId, id]),
  );
  const parts = new Map<string, StreamTurn>();
  for (const row of rows) {
    const id = summoned.get(row.id) ?? row.sendId;
    const turn = turns.get(id);
    let part = parts.get(id);
    if (part === undefined) {
      part = { id, seq: turn?.firstSeq ?? row.seq, rows: [], turn, tokens: 0 };
      parts.set(id, part);
    }
    part.rows.push(row);
  }
  const lookups = channelLookups(rows, turns);
  return [...parts.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((part) => ({
      ...part,
      // A fixed wire-neutral shape, no model, results or availability marks.
      tokens: tokens(JSON.stringify(tracedTurn(part, lookups, null))),
    }));
}

export function trimStream(
  parts: readonly StreamTurn[],
  budget: number,
  step: number,
): {
  kept: StreamTurn[];
  tokens: number;
  dropped: number;
  from: number | null;
} {
  const total = parts.reduce((sum, part) => sum + part.tokens, 0);
  if (total <= budget) {
    return { kept: [...parts], tokens: total, dropped: 0, from: null };
  }
  const target = Math.max(total - budget, step);
  let at = 0;
  let dropped = 0;
  while (at < parts.length && dropped < target) {
    dropped += parts[at++]!.tokens;
  }
  const kept = parts.slice(at);
  const end = parts.reduce(
    (max, part) => part.rows.reduce((n, row) => Math.max(n, row.seq), max),
    0,
  );
  return {
    kept,
    tokens: total - dropped,
    dropped,
    from: kept[0]?.seq ?? end + 1,
  };
}

// a run's post is never a reader's own turn, even its own agent's: it
// went to the channel after the run, never through this stream
export const ownsChannelTurn = (
  part: StreamTurn,
  policy: Pick<RenderPolicy, "agentId">,
) => part.turn?.run !== true && part.turn?.agentId === policy.agentId;
