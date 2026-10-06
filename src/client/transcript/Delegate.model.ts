// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A delegate call's group in the work fold (docs/subagents.md): headed
// by its description, the child's status, tokens and cost, holding the
// child's rounds and closed by its answer. The child's calls are its
// own: the fold's count is the parent's calls, a delegate one of them.

import type { ChildWork, Message } from "../../shared/contracts/session.ts";
import { toolArguments } from "../../shared/contracts/tool.ts";
import { money, tokensText } from "../lib/format.ts";
import { type CallNode, type WorkRound, workRounds } from "./rows.ts";
import { ranCall } from "./Tool.model.ts";

export type ChildStatus = "running" | "done" | "failed" | "stopped";

// a call that ran as delegate; one never run is an ordinary row
export const isDelegate = (node: CallNode): boolean =>
  node.result !== null && ranCall(node.call, node.result).name === "delegate";

function argument(node: CallNode, name: string): string {
  const value = toolArguments(node.call.arguments)?.[name];
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export const description = (node: CallNode): string =>
  argument(node, "description") || "subagent";

export function taskOf(node: CallNode): string {
  const value = toolArguments(node.call.arguments)?.task;
  return typeof value === "string" ? value : "";
}

// running while the parent's row runs; then the child's own end, since
// a stopped or timed out child is a failed result to its parent
export function childStatus(row: Message, work: ChildWork | null): ChildStatus {
  if (row.status === "streaming") return "running";
  if (work !== null && work.status !== "running") return work.status;
  return row.status === "done" || row.status === "stopped"
    ? row.status
    : "failed";
}

export function childHead(status: ChildStatus, work: ChildWork | null): string {
  const parts: string[] = [status];
  if (work !== null && work.tokens > 0) parts.push(tokensText(work.tokens));
  if (work?.cost != null) parts.push(money(work.cost));
  return parts.join(" · ");
}

export type ChildView = { rounds: WorkRound[]; answer: Message | null };

// the child's rows as the fold draws a send's: its work rounds, then
// its answer
export function childView(rows: Message[]): ChildView {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  return {
    rounds: workRounds(
      ordered.filter(
        (row) =>
          (row.kind === "reply" && row.slot === "work") || row.kind === "tool",
      ),
    ),
    answer:
      ordered.find((row) => row.kind === "reply" && row.slot === "answer") ??
      null,
  };
}
