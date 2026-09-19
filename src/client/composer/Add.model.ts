// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The switches of the plus menu. Web access is live when the picked
// agent takes tools and the instance has web access on, and then on
// unless the chat turned it off. MCP servers is there when the picked
// agent is offered any, and leads to a switch per server. An item that
// cannot be switched shows off and says why on a line under its name.

import type { SwitchableServer } from "../../shared/api/sessions.ts";
import { mcpKey, WEB } from "../../shared/capabilities.ts";

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

// whether another agent was picked. The list going away for a moment,
// a project loading or a failed refresh, is no pick: the flips of the
// agent that comes back are kept
export function agentMoved(last: string | null, next: string | null): boolean {
  return last !== null && next !== null && last !== next;
}

export type ServerRow = SwitchableServer & { key: string; on: boolean };
export type ServersItem = {
  live: boolean;
  reason: string | null;
  // how many are off, the words at the item's end; 0 says nothing
  off: number;
  rows: ServerRow[];
};

// null when the picked agent has no server to switch: no item at all
export function serversItem(input: {
  tools: boolean;
  // the picked agent's servers, from the project's agents route
  servers: readonly SwitchableServer[];
  // whether a key is off, as the composer shows it
  isOff: (key: string) => boolean;
}): ServersItem | null {
  if (input.servers.length === 0) return null;
  if (!input.tools) {
    return {
      live: false,
      reason: "Agent cannot use tools",
      off: 0,
      rows: [],
    };
  }
  const rows = input.servers.map((server) => {
    const key = mcpKey(server.id);
    return { ...server, key, on: !input.isOff(key) };
  });
  return {
    live: true,
    reason: null,
    off: rows.filter((row) => !row.on).length,
    rows,
  };
}
