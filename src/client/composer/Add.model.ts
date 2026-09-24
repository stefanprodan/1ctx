// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The switches of the plus menu. Web access is live when the picked
// agent takes tools and the instance has web access on, and then on
// unless the chat turned it off. When the project has credentials it
// leads to a pane instead: Web access first, then a switch per
// credential, which goes with it. MCP servers is there when the picked
// agent is offered any, and leads to a switch per server; Skills is the
// same for the skills it carries. A pane's item counts what is on. An
// item that cannot be switched shows off and says why on a line under
// its name.

import type {
  SwitchableCredential,
  SwitchableServer,
  SwitchableSkill,
} from "../../shared/api/sessions.ts";
import {
  credentialKey,
  mcpKey,
  skillKey,
  VISUALIZE,
  WEB,
} from "../../shared/capabilities.ts";
import type { IconName } from "../lib/icons.tsx";

export type WebItem = { live: boolean; on: boolean; reason: string | null };

// a switch for a kind alone, web access or the visualize tool: live when
// the picked agent takes tools and the admin has the kind on
function kindItem(
  key: string,
  input: {
    tools: boolean;
    switchable: readonly string[] | null;
    off: boolean;
  },
): WebItem {
  if (!input.tools) {
    return { live: false, on: false, reason: "Agent cannot use tools" };
  }
  if (input.switchable === null)
    return { live: false, on: false, reason: null };
  if (!input.switchable.includes(key)) {
    return { live: false, on: false, reason: "Turned off by an admin" };
  }
  return { live: true, on: !input.off, reason: null };
}

export function webItem(input: {
  // the picked agent's model takes tools
  tools: boolean;
  // the keys the project's agents route says can be switched, null
  // until it answered
  switchable: readonly string[] | null;
  // the chat has it off, as the composer shows it
  off: boolean;
}): WebItem {
  return kindItem(WEB, input);
}

// the Visuals item, the admin's name for the tool so one word means it
// on both pages
export function visualsItem(input: {
  tools: boolean;
  switchable: readonly string[] | null;
  off: boolean;
}): WebItem {
  return kindItem(VISUALIZE, input);
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
  // whether it can be flipped, and why not on a line under its name
  live: boolean;
  reason: string | null;
  // in place of the pane's own icon
  icon?: IconName;
  // a word, not an identifier: not in the mono face
  plain?: boolean;
};
export type PaneItem = {
  live: boolean;
  reason: string | null;
  // how many are on, the words at the item's end
  on: number;
  rows: PaneRow[];
};

// the words at a pane item's end
export const onWords = (item: PaneItem) => `${item.on} on`;

// whether the plus falls back to its menu: closed, or what the open pane
// lists gone. The menu itself is no such case, or the reset queued on the
// way back from a pane would undo a pane picked before it ran
export function panelessOf(
  open: boolean,
  pane: "menu" | "web" | "servers" | "skills",
  shown: PaneItem | null,
): boolean {
  return !open || (pane !== "menu" && (shown === null || !shown.live));
}

// null when the picked agent has nothing to switch: no item at all
function paneItem(
  tools: boolean,
  things: Pick<PaneRow, "key" | "name" | "note">[],
  isOff: (key: string) => boolean,
): PaneItem | null {
  if (things.length === 0) return null;
  if (!tools) {
    return { live: false, reason: "Agent cannot use tools", on: 0, rows: [] };
  }
  const rows = things.map((thing) => ({
    ...thing,
    on: !isOff(thing.key),
    live: true,
    reason: null,
  }));
  return {
    live: true,
    reason: null,
    on: rows.filter((row) => row.on).length,
    rows,
  };
}

// Web access with the project's credentials under it, null without any,
// when the item stays the plain switch. A credential goes with the web:
// faint and off while Web access is off or cannot be switched, with the
// same reason. The count is of the credentials a send would sign with
export function webPaneItem(input: {
  web: WebItem;
  // the project's, for any agent
  credentials: readonly SwitchableCredential[];
  isOff: (key: string) => boolean;
}): PaneItem | null {
  const { web } = input;
  if (input.credentials.length === 0) return null;
  const reachable = web.live && web.on;
  const why = web.reason ?? (web.live ? "Web access is off" : null);
  const rows: PaneRow[] = input.credentials.map((credential) => {
    const key = credentialKey(credential.id);
    return {
      key,
      name: credential.name,
      note: "",
      on: reachable && !input.isOff(key),
      live: reachable,
      reason: reachable ? null : why,
      icon: "key",
    };
  });
  return {
    // the pane opens to show why the web cannot be switched, and waits
    // only for the project's agents to answer
    live: web.live || web.reason !== null,
    reason: web.reason,
    on: rows.filter((row) => row.on).length,
    rows: [
      {
        key: WEB,
        name: "Web access",
        note: "",
        on: web.on,
        live: web.live,
        reason: web.reason,
        icon: "globe",
        plain: true,
      },
      ...rows,
    ],
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
