// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The transcript's nodes. The rows are grouped by send and read by
// slot: the server's word on where a reply shows, never the live map,
// the call arrays or a finish reason. Per send, outside the work fold
// there is the user row and at most one reply node, whose row has slot
// "answer" or is a streaming reply with a null slot.
//
// Commit 1 renders the answers alone: the work reply rows and the tool
// rows are grouped but dropped from the returned nodes, so nothing of
// the fold leaks before the work group exists. The live map is looked
// up for the reply node's row by id; placement never depends on it.

import type { Message } from "../../shared/contracts/session.ts";
import type { Live } from "./stream.ts";

export type Node =
  | { kind: "user"; message: Message }
  | {
      kind: "reply";
      message: Message;
      live: Live | null;
      think: boolean;
    };

// a reply that shows in the main column: the send's answer, or its
// reply streaming with a null slot before the server has placed it
function isMainReply(message: Message): boolean {
  if (message.kind !== "reply") return false;
  if (message.slot === "answer") return true;
  return message.slot === null && message.status === "streaming";
}

export function groupRows(
  messages: Message[],
  live: ReadonlyMap<string, Live>,
): Node[] {
  const ordered = [...messages].sort((left, right) => left.seq - right.seq);
  const sends = new Map<string, Message[]>();
  for (const message of ordered) {
    const rows = sends.get(message.sendId) ?? [];
    rows.push(message);
    sends.set(message.sendId, rows);
  }
  const nodes: Node[] = [];
  for (const rows of sends.values()) {
    for (const message of rows) {
      if (message.kind === "user") nodes.push({ kind: "user", message });
    }
    // The durable answer wins over a stale streaming row. Otherwise the
    // one unplaced streaming reply is the answer in progress.
    const message =
      rows.find((row) => row.kind === "reply" && row.slot === "answer") ??
      rows.find(isMainReply);
    if (message === undefined) continue;
    const current = live.get(message.id) ?? null;
    nodes.push({
      kind: "reply",
      message,
      live: current,
      think: (current?.reasoning ?? "") !== "" || message.reasoning !== "",
    });
  }
  return nodes;
}
