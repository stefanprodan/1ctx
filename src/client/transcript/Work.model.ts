// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message, SendSummary } from "../../shared/contracts/session.ts";
import type { WorkNode } from "./rows.ts";
import { secs } from "./stream.ts";

export type SendCounters = {
  rounds: number;
  toolCalls: number;
};

const count = (value: number, one: string, many: string) =>
  `${value} ${value === 1 ? one : many}`;

// the send's counters, from its summary when the client holds it, else
// from its rows the way the server counts: a round per reply, a call
// per tool row (a launched call; a call a cap cut has no row). Null
// when the send did no work
export function sendCounters(
  rows: Message[],
  send: SendSummary | null,
): SendCounters | null {
  const worked = rows.some(
    (row) =>
      row.kind === "tool" || (row.kind === "reply" && row.slot === "work"),
  );
  if (!worked) return null;
  return {
    rounds:
      send?.rounds ?? rows.reduce((last, row) => Math.max(last, row.round), 1),
    toolCalls:
      send?.toolCalls ?? rows.filter((row) => row.kind === "tool").length,
  };
}

export function counterText(counters: SendCounters): string {
  return `${count(counters.rounds, "round", "rounds")} · ${count(
    counters.toolCalls,
    "tool call",
    "tool calls",
  )}`;
}

export type WorkSummary = SendCounters & {
  live: boolean;
  durationMs: number;
  text: string;
};

export function workSummary(node: WorkNode, live: boolean): WorkSummary {
  const sendRows =
    node.answer === null ? node.rows : [...node.rows, node.answer];
  // a work node always has work rows, so the counters exist
  const counters = sendCounters(sendRows, node.send) ?? {
    rounds: 1,
    toolCalls: 0,
  };
  const first =
    node.rounds[0]?.message.createdAt ?? node.rows[0]?.createdAt ?? 0;
  const rowEnd = node.rows.reduce(
    (end, row) => Math.max(end, row.finishedAt ?? row.createdAt),
    first,
  );
  const end =
    node.answer?.createdAt ?? node.send?.finishedAt ?? (live ? first : rowEnd);
  const durationMs = Math.max(0, end - first);
  const calls = count(counters.toolCalls, "tool call", "tool calls");
  const text = live
    ? `working · ${calls}`
    : `worked ${secs(durationMs)} · ${counterText(counters)}`;
  return { ...counters, live, durationMs, text };
}
