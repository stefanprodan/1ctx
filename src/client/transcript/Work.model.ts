// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The fold's label. While the send runs, a clock and the calls
// finished so far as a sign of progress; once done, how long the work
// took, the calls, the failures and whether a cap ended the loop.

import type {
  LiveRetry,
  Message,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import type { WorkNode } from "./rows.ts";
import { clock, secs } from "./stream.ts";

const count = (value: number) => `${value} tool${value === 1 ? "" : "s"}`;

// a round waiting to ask its provider again: which of its retries
const retrying = (retry: LiveRetry | null) =>
  retry === null ? "" : ` · retrying ${retry.attempt}/${retry.max}`;

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

export function capWord(rows: Message[]): string | null {
  let repeat = false;
  for (const row of rows) {
    if (row.kind !== "reply") continue;
    if (row.finishReason === "tool_limit") return "tool limit";
    if (row.finishReason === "token_limit") return "token limit";
    if (row.finishReason === "context_limit") return "context full";
    if (row.finishReason === "tool_loop") return "tool loop";
    if (row.finishReason === "tool_repeat") repeat = true;
  }
  // a refused repeat the loop went on from, unless a cap ended it
  return repeat ? "repeat refused" : null;
}

export function workSummary(
  node: WorkNode,
  live: boolean,
  now = 0,
  retry: LiveRetry | null = null,
): WorkSummary {
  const tools = node.rows.filter(isTool);
  const finished = tools.filter(
    (row) => row.status === "done" || row.status === "failed",
  ).length;
  const failed = tools.filter((row) => row.status === "failed").length;
  // the calls the runner counts are the launched ones: a row each. A
  // run's memory phase keeps counting on the send, and its rows are
  // drawn apart, so this fold counts its own
  const toolCalls =
    node.send === null || node.send.memoryRound !== null
      ? tools.length
      : node.send.toolCalls;

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
    text += retrying(retry);
  } else {
    text = `Worked for ${secs(durationMs)}`;
    if (toolCalls > 0) text += ` · ${count(toolCalls)}`;
    if (failed > 0) text += `, ${failed} failed`;
    const cap = capWord(answer === null ? node.rows : [...node.rows, answer]);
    if (cap !== null) text += `, ${cap}`;
  }
  return { live, toolCalls, failed, durationMs, text };
}

// whether the run carries its agent's mark, which only the run's end
// writes: a call the end never committed, as a crash leaves it, is not
// a mark
export const agentMarked = (
  session: Pick<SessionSummary, "attention" | "attentionSource">,
): boolean => session.attentionSource === "agent" && session.attention !== null;

// The fold after a run's answer: its attention step, then its memory
// phase, one line for both. Running, which of them is on; done, what
// they did and the time both took. Marked is the run's own mark
// (agentMarked()), never the step's tool row.
export function memorySummary(
  node: WorkNode,
  live: boolean,
  now = 0,
  retry: LiveRetry | null = null,
  marked = false,
): WorkSummary {
  const base = workSummary(node, live, now);
  const send = node.send;
  const step = send?.attentionRound ?? null;
  const memoryFrom = send?.memoryFrom ?? null;
  const time = secs(base.durationMs);
  let text: string;
  if (live) {
    // the server names the memory phase's first round once it starts
    text =
      step !== null && memoryFrom === null
        ? `Checking ${clock(base.durationMs)}${retrying(retry)}`
        : `Updating memory ${clock(base.durationMs)}${retrying(retry)}`;
    return { ...base, text };
  }
  const stepRows =
    step === null
      ? []
      : node.rows.filter(
          (row) =>
            row.round >= step &&
            (memoryFrom === null || row.round < memoryFrom),
        );
  const tools = node.rows.filter((row) => row.kind === "tool");
  const edits = tools.filter((row) => row.toolName === "memory_edit");
  // a step that failed, ran out of time or was stopped checked nothing
  const unchecked =
    !marked &&
    stepRows.some(
      (row) =>
        row.kind === "reply" &&
        (row.status === "failed" || row.status === "stopped"),
    );
  // the commit is the edits that went through; a none changes nothing,
  // and refused edits alone leave the note as it was
  const calls = new Map(
    node.rows.flatMap((row) =>
      (row.toolCalls ?? []).map((call) => [call.id, call.arguments]),
    ),
  );
  const changed = edits.filter(
    (row) =>
      row.status === "done" &&
      !/"action"\s*:\s*"none"/.test(calls.get(row.toolCallId ?? "") ?? ""),
  ).length;
  const refused = edits.filter((row) => row.status === "failed").length;
  if (send?.memoryError != null) {
    const first = marked
      ? `Marked in ${time}. `
      : unchecked
        ? "Not checked. "
        : "";
    text = `${first}Memory not updated. ${send.memoryError}`;
  } else if (marked) {
    text =
      changed > 0
        ? `Marked and memory updated in ${time}`
        : `Marked in ${time}`;
  } else if (unchecked) {
    text =
      changed > 0
        ? `Not checked, memory updated in ${time}`
        : `Not checked in ${time}`;
  } else if (changed > 0) {
    text = `Memory updated in ${time}`;
  } else if (step !== null) {
    text = `Checked in ${time}`;
  } else {
    text =
      refused > 0
        ? `Memory not updated, ${refused} ${refused === 1 ? "edit" : "edits"} refused`
        : "Memory unchanged";
  }
  if (send?.memorySkipped != null && send.memorySkipped > 0) {
    text += `, ${send.memorySkipped} edits no longer applied`;
  }
  return { ...base, text };
}
