// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The switches of the plus menu. Web access is live when the picked
// agent takes tools and the instance has web access on, and then on
// unless the chat turned it off. MCP servers is there when the picked
// agent is offered any, and leads to a switch per server; Skills is the
// same for the skills it carries. An item that cannot be switched shows
// off and says why on a line under its name.

import type {
  SwitchableServer,
  SwitchableSkill,
} from "../../shared/api/sessions.ts";
import { mcpKey, skillKey, WEB } from "../../shared/capabilities.ts";

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

// a switch of a pane: the key it flips, and what stands before the switch
export type PaneRow = {
  key: string;
  name: string;
  note: string;
  on: boolean;
};
export type PaneItem = {
  live: boolean;
  reason: string | null;
  // how many are off, the words at the item's end; 0 says nothing
  off: number;
  rows: PaneRow[];
};

// whether the plus falls back to its menu: closed, or what the open pane
// lists gone. The menu itself is no such case, or the reset queued on the
// way back from a pane would undo a pane picked before it ran
export function panelessOf(
  open: boolean,
  pane: "menu" | "servers" | "skills",
  shown: PaneItem | null,
): boolean {
  return !open || (pane !== "menu" && (shown === null || !shown.live));
}

// null when the picked agent has nothing to switch: no item at all
function paneItem(
  tools: boolean,
  things: Omit<PaneRow, "on">[],
  isOff: (key: string) => boolean,
): PaneItem | null {
  if (things.length === 0) return null;
  if (!tools) {
    return { live: false, reason: "Agent cannot use tools", off: 0, rows: [] };
  }
  const rows = things.map((thing) => ({ ...thing, on: !isOff(thing.key) }));
  return {
    live: true,
    reason: null,
    off: rows.filter((row) => !row.on).length,
    rows,
  };
}

export function serversItem(input: {
  tools: boolean;
  // the picked agent's servers, from the project's agents route
  servers: readonly SwitchableServer[];
  // whether a key is off, as the composer shows it
  isOff: (key: string) => boolean;
}): PaneItem | null {
  return paneItem(
    input.tools,
    input.servers.map((server) => ({
      key: mcpKey(server.id),
      name: server.name,
      note: `${server.tools} tools`,
    })),
    input.isOff,
  );
}

// a skill is read through a tool, so an agent without tools has none
export function skillsItem(input: {
  tools: boolean;
  skills: readonly SwitchableSkill[];
  isOff: (key: string) => boolean;
}): PaneItem | null {
  return paneItem(
    input.tools,
    input.skills.map((skill) => ({
      key: skillKey(skill.id),
      name: skill.name,
      note: "",
    })),
    input.isOff,
  );
}
