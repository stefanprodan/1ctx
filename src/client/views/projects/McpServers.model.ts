// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ProjectMcpServer } from "../../../shared/api/mcp.ts";
import type { McpSide } from "../../../shared/contracts/mcp.ts";
import { SIDE_WORDS } from "../admin/Mcp.model.ts";
import { serverMeta } from "../directory/Directory.model.ts";

export const TEAM_TEXT = "Tools for agents, chosen by admins.";
export const PERSONAL_TEXT = "Tools for agents, offered by admins.";

export const mcpText = (personal: boolean): string =>
  personal ? PERSONAL_TEXT : TEAM_TEXT;

// under a server's name: its tools here, then on a team project every
// team project or this one; a personal project's grant is every one's
export function rowLine(row: ProjectMcpServer, personal: boolean): string {
  if (personal) return serverMeta(row);
  return `${serverMeta(row)} · ${
    row.scope === "all" ? "All team projects" : "This project"
  }`;
}

// what a row is for its viewer: a team's admin picks its side and
// follows it to the server's page, removing a listed one there too; the
// owner of a personal project picks its side; anyone else reads the word
export type RowKind = "admin" | "owner" | "read";

export function rowKind(admin: boolean, personal: boolean): RowKind {
  if (personal) return "owner";
  return admin ? "admin" : "read";
}

// the sides a row may pick: Off always, Read while the server's Read is
// on, Read and write only under a write ceiling
export function pickOptions(
  row: Pick<ProjectMcpServer, "read" | "ceiling">,
): { value: McpSide; label: string }[] {
  const sides: McpSide[] = [
    "off",
    ...(row.read ? (["read"] as const) : []),
    ...(row.ceiling === "write" ? (["write"] as const) : []),
  ];
  return sides.map((value) => ({ value, label: SIDE_WORDS[value] }));
}

// the pick shown: the choice, or what it gives when the ceiling dropped
// under it, which the choice comes back to when the ceiling does
export function pickValue(
  row: Pick<ProjectMcpServer, "choice" | "side" | "read" | "ceiling">,
): McpSide {
  return pickOptions(row).some((o) => o.value === row.choice)
    ? row.choice
    : row.side;
}

// a reader's word: what the project's agents are given
export const sideWord = (row: Pick<ProjectMcpServer, "side">): string =>
  SIDE_WORDS[row.side];

// the open form: the row as it was when it opened, or none
export type OpenServer = ProjectMcpServer | null;

// a row gone from the list, or widened to every project, closes its form
export function openOf(
  open: OpenServer,
  list: readonly ProjectMcpServer[],
): OpenServer {
  if (open === null) return null;
  return list.some((s) => s.id === open.id && s.scope === "projects")
    ? open
    : null;
}

// the confirm: the last project out leaves the server offered nowhere
export function removeAsk(
  row: Pick<ProjectMcpServer, "name" | "projects">,
  project: string,
): string {
  const ask = `Remove ${row.name} from ${project}?`;
  return row.projects === 1 ? `${ask} It will be offered in no project.` : ask;
}
