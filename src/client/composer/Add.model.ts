// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Web access item of the plus menu: live when the picked agent
// takes tools and the instance has web access on, and then on unless the
// chat turned it off. An item that cannot be switched shows off and says
// why on a line under its name.

import { WEB } from "../../shared/capabilities.ts";

export type WebItem = { live: boolean; on: boolean; reason: string | null };

export function webItem(input: {
  // the picked agent's model takes tools
  tools: boolean;
  // the keys the project's agents route says can be switched, null
  // until it answered
  switchable: readonly string[] | null;
  // the chat has it off, as the composer shows it
  off: boolean;
}): WebItem {
  if (!input.tools) {
    return { live: false, on: false, reason: "Agent cannot use tools" };
  }
  if (input.switchable === null)
    return { live: false, on: false, reason: null };
  if (!input.switchable.includes(WEB)) {
    return { live: false, on: false, reason: "Turned off by an admin" };
  }
  return { live: true, on: !input.off, reason: null };
}
