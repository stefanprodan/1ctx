// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The fold's label. While the send runs, a clock and the calls
// finished so far as a sign of progress; once done, how long the work
// took, the calls, the failures and whether a cap ended the loop.

import type { Message } from "../../shared/contracts/session.ts";
import type { WorkNode } from "./rows.ts";
import { secs } from "./stream.ts";

const count = (value: number) => `${value} tool${value === 1 ? "" : "s"}`;

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

// the live clock in whole seconds: a decimal ticking ten times a
// second is noise
function clock(ms: number): string {
  if (ms >= 60_000) return secs(ms);
  return `${Math.floor(ms / 1000)} s`;
}

export function workSummary(
  node: WorkNode,
  live: boolean,
  now = 0,
): WorkSummary {
  const tools = node.rows.filter(isTool);
  const finished = tools.filter(
    (row) => row.status === "done" || row.status === "failed",
  ).length;
  const failed = tools.filter((row) => row.status === "failed").length;
  // the calls the runner counts are the launched ones: a row each
  const toolCalls = node.send?.toolCalls ?? tools.length;

  // a send without tools worked until its answer began: the first
  // token, or the end of its thinking
  const answer = node.answer;
  const first =
    node.rounds[0]?.message.createdAt ??
    node.rows[0]?.createdAt ??
    answer?.createdAt ??
    node.send?.startedAt ??
    0;
  const rowEnd = node.rows.reduce(
    (end, row) => Math.max(end, row.finishedAt ?? row.createdAt),
    first,
  );
  // the answer's own thinking sits in the fold, so its time counts
  const thoughtEnd =
    answer === null
      ? null
      : answer.createdAt + (answer.ttftMs ?? 0) + (answer.thinkingMs ?? 0);
  const end = live
    ? now
    : Math.max(rowEnd, thoughtEnd ?? node.send?.finishedAt ?? rowEnd);
  const durationMs = Math.max(0, end - first);

  let text: string;
  if (live) {
    // the clock runs so a long send is seen to move
    text = `Working ${clock(durationMs)}`;
    if (finished > 0) text += ` · ${count(finished)}`;
  } else {
    text = `Worked for ${secs(durationMs)}`;
    if (toolCalls > 0) text += ` · ${count(toolCalls)}`;
    if (failed > 0) text += `, ${failed} failed`;
    const cap = capWord(answer === null ? node.rows : [...node.rows, answer]);
    if (cap !== null) text += `, ${cap}`;
  }
  return { live, toolCalls, failed, durationMs, text };
}

// the Memory fold's line: the phase running, then what it did
export function memorySummary(
  node: WorkNode,
  live: boolean,
  now = 0,
): WorkSummary {
  const base = workSummary(node, live, now);
  const send = node.send;
  let text: string;
  if (live) {
    text = `Updating memory ${clock(base.durationMs)}`;
  } else if (send?.memoryError != null) {
    text = `Memory not updated. ${send.memoryError}`;
  } else {
    // the commit is the edits that went through; none means the note
    // stayed as it was
    const edits = node.rows.filter(
      (row) =>
        row.kind === "tool" &&
        row.toolName === "memory_edit" &&
        row.status === "done",
    ).length;
    text = edits === 0 ? "Memory unchanged" : "Memory updated";
    if (send?.memorySkipped != null && send.memorySkipped > 0) {
      text += `, ${send.memorySkipped} edits no longer applied`;
    }
  }
  return { ...base, text };
}
