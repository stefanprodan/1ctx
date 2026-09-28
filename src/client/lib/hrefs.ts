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

// a user's admin page, under Access
export const USERS_HREF = "/admin/access/users";
export function adminUserHref(username: string): string {
  return `${USERS_HREF}/${encodeURIComponent(username)}`;
}

// a team project's admin page, under Access, by id
export const PROJECTS_HREF = "/admin/access/projects";
export function adminProjectHref(id: string): string {
  return `${PROJECTS_HREF}/${encodeURIComponent(id)}`;
}

export function agentHref(name: string): string {
  return `/agents/${encodeURIComponent(name)}`;
}

// a provider's page under Config
export function configProviderHref(name: string): string {
  return `/admin/config/providers/${encodeURIComponent(name)}`;
}

// New agent, opened on a provider's models
export function newAgentHref(provider: string): string {
  return `/admin/config/agents?new&provider=${encodeURIComponent(provider)}`;
}

// a decider's page, and a decision's, under Config
export function configDeciderHref(name: string): string {
  return `/admin/config/deciders/${encodeURIComponent(name)}`;
}
export function configDecisionHref(id: string): string {
  return `/admin/config/decisions/${encodeURIComponent(id)}`;
}

// an MCP server's page under Config, on General or Tools
export type McpTab = "general" | "tools";
export function configMcpHref(name: string, tab: McpTab = "general") {
  const base = `/admin/config/mcp/${encodeURIComponent(name)}`;
  return tab === "general" ? base : `${base}/${tab}`;
}

// Web access's Credentials tab, and a credential's page under it
export const CREDENTIALS_HREF = "/admin/config/web/credentials";
export function configCredentialHref(name: string) {
  return `${CREDENTIALS_HREF}/${encodeURIComponent(name)}`;
}

// a skill's page under Config, on General or Files
export type SkillTab = "general" | "files";
export function configSkillHref(name: string, tab: SkillTab = "general") {
  const base = `/admin/config/skills/${encodeURIComponent(name)}`;
  return tab === "general" ? base : `${base}/${tab}`;
}

// an agent's page under Config, on one of its tabs
export type AgentTab = "general" | "skills" | "mcp";
export function configAgentHref(name: string, tab: AgentTab = "general") {
  const base = `/admin/config/agents/${encodeURIComponent(name)}`;
  return tab === "general" ? base : `${base}/${tab}`;
}

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
