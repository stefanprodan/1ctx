// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The transcript's nodes. Rows are grouped by send and placed by the
// server's slot. Tool calls are read only after placement, to pair each
// work round with its result rows.

import type { Message, SendSummary } from "../../shared/contracts/session.ts";
import type { ToolCall } from "../../shared/contracts/tool.ts";

export type CallNode = {
  key: string;
  call: ToolCall;
  result: Message | null;
};

export type WorkRound = {
  message: Message;
  calls: CallNode[];
};

export type WorkNode = {
  kind: "work";
  sendId: string;
  rows: Message[];
  rounds: WorkRound[];
  answer: Message | null;
  send: SendSummary | null;
};

export type Node =
  | { kind: "user"; message: Message }
  | WorkNode
  | {
      kind: "reply";
      message: Message;
      rows: Message[];
      send: SendSummary | null;
    };

function isMainReply(message: Message): boolean {
  if (message.kind !== "reply") return false;
  if (message.slot === "answer") return true;
  return message.slot === null && message.status === "streaming";
}

type ResultQueue = { rows: Message[]; next: number };

function workRounds(rows: Message[]): WorkRound[] {
  const replies: Message[] = [];
  const results = new Map<number, Map<string, ResultQueue>>();
  for (const row of rows) {
    if (row.kind === "reply" && row.slot === "work") {
      replies.push(row);
      continue;
    }
    if (row.kind !== "tool" || row.toolCallId === null) continue;
    let round = results.get(row.round);
    if (round === undefined) {
      round = new Map();
      results.set(row.round, round);
    }
    const queue = round.get(row.toolCallId) ?? { rows: [], next: 0 };
    queue.rows.push(row);
    round.set(row.toolCallId, queue);
  }

  return replies.map((message) => ({
    message,
    calls: (message.toolCalls ?? []).map((call, index) => {
      const queue = results.get(message.round)?.get(call.id);
      const result = queue?.rows[queue.next] ?? null;
      if (queue !== undefined && result !== null) queue.next++;
      return {
        key: `${message.id}:${index}`,
        call,
        result,
      };
    }),
  }));
}

export function groupRows(
  messages: Message[],
  currentSend: SendSummary | null = null,
): Node[] {
  const ordered = [...messages].sort((left, right) => left.seq - right.seq);
  const sends = new Map<string, Message[]>();
  for (const message of ordered) {
    const rows = sends.get(message.sendId) ?? [];
    rows.push(message);
    sends.set(message.sendId, rows);
  }

  const nodes: Node[] = [];
  for (const [sendId, rows] of sends) {
    const user = rows.find((row) => row.kind === "user");
    if (user !== undefined) nodes.push({ kind: "user", message: user });

    const answer =
      rows.find((row) => row.kind === "reply" && row.slot === "answer") ?? null;
    const work = rows.filter(
      (row) =>
        (row.kind === "reply" && row.slot === "work") || row.kind === "tool",
    );
    const send = currentSend?.id === sendId ? currentSend : null;
    if (work.length > 0) {
      nodes.push({
        kind: "work",
        sendId,
        rows: work,
        rounds: workRounds(work),
        answer,
        send,
      });
    }

    const reply = answer ?? rows.find(isMainReply);
    if (reply !== undefined && reply !== null) {
      nodes.push({ kind: "reply", message: reply, rows, send });
    }
  }
  return nodes;
}
