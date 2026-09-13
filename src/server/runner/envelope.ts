// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The session.changed envelope the writer publishes after each of its
// transactions, and the stream's last line it carries when the
// transaction wrote a user message or a finished answer. Out of the
// writer so that file stays under the size rule.

import type {
  LastLine,
  Message,
  SendSummary,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import type { BusEvent } from "../lib/bus.ts";
import { lineFrom, offWire } from "../sessions/index.ts";

export const envelope = (
  session: SessionSummary,
  messages: Message[],
  send: SendSummary | null,
  removedMessageIds: string[] = [],
  last?: LastLine,
): BusEvent => ({
  type: "session.changed",
  data: {
    projectId: session.projectId,
    session,
    messages: messages.map(offWire),
    ...(removedMessageIds.length > 0 ? { removedMessageIds } : {}),
    send,
    ...(last === undefined ? {} : { last }),
  },
});

// undefined for a row with nothing to say, so the envelope keeps the
// line the client holds rather than showing an empty one
export const lastLine = (
  message: Message,
  author: string,
): LastLine | undefined => {
  const text = lineFrom(message.content);
  return text === "" ? undefined : { seq: message.seq, author, text };
};
