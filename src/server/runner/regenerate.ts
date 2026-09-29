// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message } from "../../shared/contracts/session.ts";
import { BadRequest } from "../lib/errors.ts";

// the user messages the last turn opened with: the run of user rows
// that ends at the last one, so a turn of several is redone whole
export function regenerateUsers(messages: readonly Message[]): Message[] {
  if (messages.length === 0 || messages.at(-1)?.kind === "user") {
    throw new BadRequest("nothing to regenerate");
  }
  const last = messages.findLastIndex((message) => message.kind === "user");
  if (last === -1) throw new BadRequest("nothing to regenerate");
  let first = last;
  while (first > 0 && messages[first - 1]!.kind === "user") first--;
  return messages.slice(first, last + 1);
}
