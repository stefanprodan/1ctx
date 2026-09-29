// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A turn that opens with several user messages, each with its author,
// started as one send so the model reads them side by side before it
// acts. Each message keeps a message's own bounds.

import type { SendMessageRequest } from "../../shared/api/sessions.ts";
import {
  applyChange,
  type CapabilityChange,
} from "../../shared/capabilities.ts";
import { BadRequest } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import { parseSendMessage } from "../sessions/index.ts";

// the most user messages one turn opens with
export const MAX_TURN_MESSAGES = 16;

export type TurnMessage = SendMessageRequest & { principal: Principal };

export function checkTurn(messages: readonly TurnMessage[]): void {
  if (messages.length === 0 || messages.length > MAX_TURN_MESSAGES) {
    throw new BadRequest(
      `a turn must open with 1 to ${MAX_TURN_MESSAGES} messages`,
    );
  }
  for (const { message, uploads, capabilities } of messages) {
    parseSendMessage({
      message,
      ...(uploads === undefined ? {} : { uploads }),
      ...(capabilities === undefined ? {} : { capabilities }),
    });
  }
}

// the changes one after the other, as separate sends would apply them
export function applyChanges(
  set: readonly string[],
  changes: readonly (CapabilityChange | undefined)[],
): string[] {
  let current = [...set];
  for (const change of changes) {
    const changed = applyChange(current, change);
    if (!changed.ok) throw new BadRequest(changed.error);
    current = changed.set;
  }
  return current;
}
