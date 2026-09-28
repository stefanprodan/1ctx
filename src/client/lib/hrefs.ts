// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The addresses of a user's page, an agent's page, a chat, an
// automation and a chat's download, so every link to them is built one
// way.

import { browserZone } from "./zone.ts";

export function userHref(username: string): string {
  return `/users/${encodeURIComponent(username)}`;
}

export const USERS_HREF = "/admin/access/users";
export function adminUserHref(username: string): string {
  return `${USERS_HREF}/${encodeURIComponent(username)}`;
}

export const PROJECTS_HREF = "/admin/access/projects";
export function adminProjectHref(id: string): string {
  return `${PROJECTS_HREF}/${encodeURIComponent(id)}`;
}

export function agentHref(name: string): string {
  return `/agents/${encodeURIComponent(name)}`;
}

export function configProviderHref(name: string): string {
  return `/admin/config/providers/${encodeURIComponent(name)}`;
}

export function newAgentHref(provider: string): string {
  return `/admin/config/agents?new&provider=${encodeURIComponent(provider)}`;
}

export function configDeciderHref(name: string): string {
  return `/admin/config/deciders/${encodeURIComponent(name)}`;
}
export function configDecisionHref(id: string): string {
  return `/admin/config/decisions/${encodeURIComponent(id)}`;
}

export const CREDENTIALS_HREF = "/admin/config/web/credentials";
export function configCredentialHref(name: string) {
  return `${CREDENTIALS_HREF}/${encodeURIComponent(name)}`;
}

const tabHref = (base: string, name: string, tab: string) => {
  const page = `${base}/${encodeURIComponent(name)}`;
  return tab === "general" ? page : `${page}/${tab}`;
};

export type McpTab = "general" | "tools";
export const configMcpHref = (name: string, tab: McpTab = "general") =>
  tabHref("/admin/config/mcp", name, tab);

export type SkillTab = "general" | "files";
export const configSkillHref = (name: string, tab: SkillTab = "general") =>
  tabHref("/admin/config/skills", name, tab);

export type AgentTab = "general" | "skills" | "mcp";
export const configAgentHref = (name: string, tab: AgentTab = "general") =>
  tabHref("/admin/config/agents", name, tab);

export function chatHref(id: string): string {
  return `/chat/${encodeURIComponent(id)}`;
}

export function automationHref(id: string): string {
  return `/automations/${encodeURIComponent(id)}`;
}

// the chat as a Markdown file: a link the browser saves, never a fetch,
// so the cookie and the server's filename do the work. The times are
// in the browser's zone
export const markdownHref = (id: string): string =>
  `/api/sessions/${encodeURIComponent(id)}/markdown?tz=${encodeURIComponent(
    browserZone(),
  )}`;
