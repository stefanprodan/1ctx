// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ProjectMcpServer } from "../../../shared/api/mcp.ts";
import { serverMeta } from "../directory/Directory.model.ts";

export const TEAM_TEXT = "Tools for agents, managed by admins.";
export const PERSONAL_TEXT = "Servers every project has, managed by admins.";

export const mcpText = (personal: boolean): string =>
  personal ? PERSONAL_TEXT : TEAM_TEXT;

// under a server's name: its tools here, then every project or this one
export function rowLine(row: ProjectMcpServer): string {
  return `${serverMeta(row)} · ${
    row.scope === "all" ? "All projects" : "This project"
  }`;
}

// what a row is for its viewer: a team's admin opens a listed row's
// form and follows an all row to the server's page, where its scope is
// changed; a member, and anyone on a personal project, only reads it
export type RowKind = "edit" | "link" | "read";

export function rowKind(
  row: Pick<ProjectMcpServer, "scope">,
  admin: boolean,
  personal: boolean,
): RowKind {
  if (!admin || personal) return "read";
  return row.scope === "all" ? "link" : "edit";
}

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
