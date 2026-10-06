// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  LastLine,
  Message,
  SendSummary,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import type { BusEvent } from "../lib/bus.ts";
import { offWire } from "./rows.ts";

// the session.changed envelope each session transaction publishes
export const envelope = (
  session: SessionSummary,
  messages: Message[],
  send: SendSummary | null,
  removedMessageIds: string[] = [],
  last?: LastLine,
  messagesCut = false,
): BusEvent => ({
  type: "session.changed",
  data: {
    projectId: session.projectId,
    session,
    messages: messages.map(offWire),
    ...(removedMessageIds.length > 0 ? { removedMessageIds } : {}),
    send,
    ...(last === undefined ? {} : { last }),
    ...(messagesCut ? { messagesCut: true as const } : {}),
  },
});
