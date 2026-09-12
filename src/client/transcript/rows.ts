// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message } from "../../shared/contracts/session.ts";
import type { Live } from "./stream.ts";

export type Node =
  | { kind: "user"; message: Message }
  | {
      kind: "reply";
      message: Message;
      live: Live | null;
      think: boolean;
      last: boolean;
    };

export function groupRows(
  messages: Message[],
  live: ReadonlyMap<string, Live>,
): Node[] {
  const ordered = [...messages].sort((left, right) => left.seq - right.seq);
  let lastReplyId: string | null = null;
  for (const message of ordered) {
    if (message.kind === "reply") lastReplyId = message.id;
  }

  return ordered.map((message) => {
    if (message.kind === "user") return { kind: "user", message };
    const current = live.get(message.id) ?? null;
    return {
      kind: "reply",
      message,
      live: current,
      think: (current?.reasoning ?? "") !== "" || message.reasoning !== "",
      last: message.id === lastReplyId,
    };
  });
}
