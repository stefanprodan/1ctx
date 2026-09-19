// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message } from "../../shared/contracts/session.ts";
import { BadRequest } from "../lib/errors.ts";

export function regenerateUser(messages: readonly Message[]): Message {
  if (messages.length === 0 || messages.at(-1)?.kind === "user") {
    throw new BadRequest("nothing to regenerate");
  }
  const user = messages.findLast((message) => message.kind === "user");
  if (user === undefined) throw new BadRequest("nothing to regenerate");
  return user;
}
