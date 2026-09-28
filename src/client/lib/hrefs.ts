// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { browserZone } from "./zone.ts";

export const ACCESS_HREF = "/admin/access";
export const PROJECTS_HREF = "/admin/access/projects";
export const USERS_HREF = "/admin/access/users";
export const CONFIG_HREF = "/admin/config";
export const AGENTS_HREF = "/admin/config/agents";
export const DECIDERS_HREF = "/admin/config/deciders";
export const DECISIONS_HREF = "/admin/config/decisions";
export const LIMITS_HREF = "/admin/config/limits";
export const MCP_HREF = "/admin/config/mcp";
export const PROVIDERS_HREF = "/admin/config/providers";
export const SKILLS_HREF = "/admin/config/skills";
export const CONFIG_STORAGE_HREF = "/admin/config/storage";
export const VISUALS_HREF = "/admin/config/visuals";
export const WEB_HREF = "/admin/config/web";
export const CREDENTIALS_HREF = "/admin/config/web/credentials";
export const MONITOR_HREF = "/admin/monitor";
export const STORAGE_HREF = "/admin/monitor/storage";
export const USAGE_HREF = "/admin/monitor/usage";
export const DIRECTORY_HREF = "/directory";
export const DIRECTORY_AGENTS_HREF = "/directory/agents";

export function userHref(username: string): string {
  return `/users/${encodeURIComponent(username)}`;
}

export function adminUserHref(username: string): string {
  return `${USERS_HREF}/${encodeURIComponent(username)}`;
}

export function adminProjectHref(id: string): string {
  return `${PROJECTS_HREF}/${encodeURIComponent(id)}`;
}

export function agentHref(name: string): string {
  return `/agents/${encodeURIComponent(name)}`;
}

export function configProviderHref(name: string): string {
  return `${PROVIDERS_HREF}/${encodeURIComponent(name)}`;
}

export function newAgentHref(provider: string): string {
  return `${AGENTS_HREF}?new&provider=${encodeURIComponent(provider)}`;
}

export function configDeciderHref(name: string): string {
  return `${DECIDERS_HREF}/${encodeURIComponent(name)}`;
}
export function configDecisionHref(id: string): string {
  return `${DECISIONS_HREF}/${encodeURIComponent(id)}`;
}

export function configCredentialHref(name: string) {
  return `${CREDENTIALS_HREF}/${encodeURIComponent(name)}`;
}

const tabHref = (base: string, name: string, tab: string) => {
  const page = `${base}/${encodeURIComponent(name)}`;
  return tab === "general" ? page : `${page}/${tab}`;
};

export type McpTab = "general" | "tools";
export const configMcpHref = (name: string, tab: McpTab = "general") =>
  tabHref(MCP_HREF, name, tab);

export type SkillTab = "general" | "files";
export const configSkillHref = (name: string, tab: SkillTab = "general") =>
  tabHref(SKILLS_HREF, name, tab);

export type AgentTab = "general" | "skills" | "mcp";
export const configAgentHref = (name: string, tab: AgentTab = "general") =>
  tabHref(AGENTS_HREF, name, tab);

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
