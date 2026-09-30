// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message } from "../../shared/contracts/session.ts";
import { BadRequest } from "../lib/errors.ts";

// the user messages the last turn opened with, in seq order: the user
// rows of the last user row's send, so a turn of several is redone
// whole and a row an earlier send left unanswered stays
export function regenerateUsers(messages: readonly Message[]): Message[] {
  if (messages.length === 0 || messages.at(-1)?.kind === "user") {
    throw new BadRequest("nothing to regenerate");
  }
  const last = messages.findLast((message) => message.kind === "user");
  if (last === undefined) throw new BadRequest("nothing to regenerate");
  return messages
    .filter(
      (message) => message.kind === "user" && message.sendId === last.sendId,
    )
    .sort((a, b) => a.seq - b.seq);
}
