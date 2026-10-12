// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The setup lines for each agent: its MCP server and the skill. None
// holds a key; each reads it from KEY_ENV, so they stay on the page.

import { EXTERNAL_TASKS_SKILL_PATH } from "../../../shared/skills.ts";
import type { Tab } from "../../ui/Tabs.tsx";
import { KEY_ENV } from "./AccessKeys.model.ts";

export type Agent = "claude" | "codex" | "opencode";

export const CONNECT_HREF = "/connect";
export const NEW_KEY_HREF = `${CONNECT_HREF}?new`;

const AGENTS: { agent: Agent; label: string; href: string }[] = [
  { agent: "claude", label: "Claude Code", href: CONNECT_HREF },
  { agent: "codex", label: "Codex", href: `${CONNECT_HREF}/codex` },
  { agent: "opencode", label: "OpenCode", href: `${CONNECT_HREF}/opencode` },
];

export const setupTabs = (): Tab[] =>
  AGENTS.map(({ label, href }) => ({ label, href }));

export function setupAgent(pathname: string): Agent {
  return AGENTS.find((a) => a.href === pathname)?.agent ?? "claude";
}

export const hrefOf = (agent: Agent): string =>
  AGENTS.find((a) => a.agent === agent)!.href;

export const mcpUrl = (origin: string): string => `${origin}/mcp`;

export const skillUrl = (origin: string): string =>
  `${origin}${EXTERNAL_TASKS_SKILL_PATH}`;

export type SetupLine = { label: string; text: string; hint: string };

// single quotes keep ${...} for Claude Code to read at each connection;
// double quotes would let the shell write the key into its config. The
// URL is quoted so a shell never globs an IPv6 origin's brackets.
const claudeMcp = (origin: string): string =>
  [
    "claude mcp add --transport http --scope user 1ctx \\",
    `  "${mcpUrl(origin)}" \\`,
    `  --header 'Authorization: Bearer \${${KEY_ENV}}'`,
  ].join("\n");

const codexMcp = (origin: string): string =>
  [
    "[mcp_servers.1ctx]",
    `url = "${mcpUrl(origin)}"`,
    `bearer_token_env_var = "${KEY_ENV}"`,
  ].join("\n");

// oauth off: /mcp has none, so a 401 must not offer a sign-in
const opencodeMcp = (origin: string): string =>
  [
    '"mcp": {',
    '  "1ctx": {',
    '    "type": "remote",',
    `    "url": "${mcpUrl(origin)}",`,
    '    "headers": {',
    `      "Authorization": "Bearer {env:${KEY_ENV}}"`,
    "    },",
    '    "oauth": false',
    "  }",
    "}",
  ].join("\n");

const SKILL_DIRS: Record<Agent, string> = {
  claude: "~/.claude/skills",
  codex: "~/.agents/skills",
  opencode: "~/.config/opencode/skills",
};

const skillLine = (origin: string, agent: Agent): string =>
  [
    "curl -fsSL --create-dirs \\",
    `  -o ${SKILL_DIRS[agent]}/external-tasks/SKILL.md \\`,
    `  "${skillUrl(origin)}"`,
  ].join("\n");

const SKILL_HINT = "Run again after an upgrade.";

export function setupLines(origin: string, agent: Agent): SetupLine[] {
  const mcp: Record<Agent, SetupLine> = {
    claude: {
      label: "MCP server",
      text: claudeMcp(origin),
      hint: "For every project.",
    },
    codex: {
      label: "MCP server",
      text: codexMcp(origin),
      hint: "In ~/.codex/config.toml.",
    },
    opencode: {
      label: "MCP server",
      text: opencodeMcp(origin),
      hint: "In ~/.config/opencode/opencode.json.",
    },
  };
  return [
    mcp[agent],
    { label: "Skill", text: skillLine(origin, agent), hint: SKILL_HINT },
  ];
}
