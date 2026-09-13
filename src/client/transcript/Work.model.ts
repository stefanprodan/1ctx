// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The fold's label. One word while the send runs, with the calls
// finished so far as a sign of progress; once done, how long the work
// took, the calls, the failures and whether a cap ended the loop.

import type { Message } from "../../shared/contracts/session.ts";
import type { WorkNode } from "./rows.ts";
import { secs } from "./stream.ts";

const count = (value: number) => `${value} tool call${value === 1 ? "" : "s"}`;

export type WorkSummary = {
  live: boolean;
  toolCalls: number;
  failed: number;
  durationMs: number;
  text: string;
};

export function workJustEnded(wasRunning: boolean, running: boolean): boolean {
  return wasRunning && !running;
}

function isTool(row: Message): boolean {
  return row.kind === "tool";
}

// the reason the runner ended the loop, from any reply of the send: the
// answer round carries it when a cap forced the answer
export function capWord(rows: Message[]): string | null {
  for (const row of rows) {
    if (row.kind !== "reply") continue;
    if (row.finishReason === "tool_limit") return "tool limit";
    if (row.finishReason === "tool_loop") return "tool loop";
  }
  return null;
}

export function workSummary(node: WorkNode, live: boolean): WorkSummary {
  const tools = node.rows.filter(isTool);
  const finished = tools.filter(
    (row) => row.status === "done" || row.status === "failed",
  ).length;
  const failed = tools.filter((row) => row.status === "failed").length;
  // the calls the runner counts are the launched ones: a row each
  const toolCalls = node.send?.toolCalls ?? tools.length;

  const first =
    node.rounds[0]?.message.createdAt ?? node.rows[0]?.createdAt ?? 0;
  const rowEnd = node.rows.reduce(
    (end, row) => Math.max(end, row.finishedAt ?? row.createdAt),
    first,
  );
  // the answer's own thinking sits in the fold, so its time counts
  const answer = node.answer;
  const thoughtEnd =
    answer !== null && answer.thinkingMs !== null
      ? answer.createdAt + (answer.ttftMs ?? 0) + answer.thinkingMs
      : (answer?.createdAt ?? null);
  // answer generation is outside the fold; without an answer, the send
  // end is the only timestamp that includes the final work interval
  const end = live
    ? first
    : Math.max(rowEnd, thoughtEnd ?? node.send?.finishedAt ?? rowEnd);
  const durationMs = Math.max(0, end - first);

  let text: string;
  if (live) {
    text = finished > 0 ? `Working · ${count(finished)}` : "Working";
  } else {
    text = `Worked for ${secs(durationMs)}`;
    if (toolCalls > 0) text += ` · ${count(toolCalls)}`;
    if (failed > 0) text += `, ${failed} failed`;
    const cap = capWord(answer === null ? node.rows : [...node.rows, answer]);
    if (cap !== null) text += `, ${cap}`;
  }
  return { live, toolCalls, failed, durationMs, text };
}
