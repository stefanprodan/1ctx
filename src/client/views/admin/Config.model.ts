// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ToolsResponse } from "../../../shared/api/tools.ts";
import type { LimitName } from "../../../shared/contracts/limit.ts";
import type {
  AutomationToolSummary,
  BuiltinToolSummary,
  EmailToolSummary,
  WebToolSummary,
} from "../../../shared/contracts/tool.ts";
import {
  AGENTS_HREF,
  CONFIG_HREF,
  CONFIG_STORAGE_HREF,
  CREDENTIALS_HREF,
  DECIDERS_HREF,
  LIMITS_HREF,
  MCP_HREF,
  PROVIDERS_HREF,
  SKILLS_HREF,
  VISUALS_HREF,
  WEB_HREF,
} from "../../lib/hrefs.ts";

type ConfigTab = "overview" | "limits" | "storage";

export const CONFIG_TABS: { tab: ConfigTab; label: string; href: string }[] = [
  { tab: "overview", label: "Overview", href: CONFIG_HREF },
  { tab: "limits", label: "Limits", href: LIMITS_HREF },
  { tab: "storage", label: "Storage", href: CONFIG_STORAGE_HREF },
];

export function configTab(pathname: string): ConfigTab {
  return CONFIG_TABS.find((t) => t.href === pathname)?.tab ?? "overview";
}

export type LimitsGroup = {
  title: string;
  line: string;
  names: readonly LimitName[];
};

export const LIMITS_CARDS: readonly LimitsGroup[] = [
  {
    title: "Turns",
    line: "How much one turn or run may do.",
    names: [
      "rounds",
      "callsPerRound",
      "callsPerSend",
      "maxBashCalls",
      "toolMs",
      "callTimeoutMs",
      "resultBytes",
      "resultCut",
      "toolWorkTokens",
      "contextReserve",
      "summaryMaxTokens",
      "childrenAtOnce",
      "childrenPerSend",
      "childAnswerChars",
      "sendDeadlineMs",
    ],
  },
  {
    title: "Running",
    line: "How many chats and runs go at once, and what waits.",
    names: [
      "sendsPerUser",
      "sendsPerProject",
      "sendsRunning",
      "queuedPerUser",
      "queuedMinutes",
    ],
  },
  {
    title: "Automations",
    line: "How long runs take.",
    names: ["runDeadlineMs", "memoryPhaseMs", "memoryPhaseRounds"],
  },
];

export const STORAGE_CARDS: readonly LimitsGroup[] = [
  {
    title: "Knowledge",
    line: "What a project's knowledge base may hold.",
    names: [
      "knowledgeFileBytes",
      "knowledgeFiles",
      "knowledgeProjectBytes",
      "knowledgeVersions",
      "knowledgeHistoryBytes",
      "knowledgeHistoryDays",
    ],
  },
  {
    title: "Scratch",
    line: "Files a chat or run writes as it works.",
    names: ["scratchBytes", "scratchFiles", "scratchIdleDays"],
  },
  {
    title: "Chats",
    line: "Files added to chats, and when old chats go.",
    names: [
      "uploadBytes",
      "uploadFiles",
      "archiveIdleDays",
      "archivedDeleteDays",
    ],
  },
  {
    title: "MCP results",
    line: "Large results kept as files for a chat.",
    names: ["mcpKeptBytes", "mcpKeptFiles"],
  },
  {
    title: "Repositories",
    line: "Repository files kept on disk for bash.",
    names: ["repoBytes", "repoFiles", "repoFileBytes", "repoCacheBytes"],
  },
];

type AnyTool =
  | BuiltinToolSummary
  | WebToolSummary
  | EmailToolSummary
  | AutomationToolSummary;

// email_user only once email is set up, so the board looks as it did
// before email
export function builtinsOf(state: ToolsResponse): AnyTool[] {
  const email = state.emailUser.emailOn ? [state.emailUser] : [];
  return [...state.builtin, state.visualize, ...email, state.automation].sort(
    (a, b) => a.name.localeCompare(b.name),
  );
}

export function offered(tool: AnyTool, state: ToolsResponse): boolean {
  if (tool.name === "webfetch") return state.access.mode !== "off";
  if (tool.name === "websearch") {
    return state.access.mode !== "off" && state.search.provider !== null;
  }
  if (tool.name === "visualize") return state.visualize.enabled;
  if (tool.name === "automation") return state.automation.enabled;
  // the admin's switch, and email set up
  if (tool.name === "email_user") {
    return state.emailUser.enabled && state.emailUser.emailOn;
  }
  return true;
}

type InstanceLine = {
  label: string;
  value: string;
  href: string;
  quiet: boolean;
};

const MODE_WORDS: Record<ToolsResponse["access"]["mode"], string> = {
  off: "Off",
  all: "All domains",
  listed: "Listed domains",
};

// a list not loaded yet is left out
export function instanceLines(
  state: ToolsResponse,
  lists: {
    providers: readonly unknown[] | null;
    agents: readonly unknown[] | null;
    deciders: readonly unknown[] | null;
    servers: readonly unknown[] | null;
    skills: readonly unknown[] | null;
    credentials: readonly unknown[] | null;
  },
): InstanceLine[] {
  const counted = (
    label: string,
    list: readonly unknown[] | null,
    href: string,
  ): InstanceLine[] =>
    list === null
      ? []
      : [{ label, value: String(list.length), href, quiet: list.length === 0 }];
  const mode = state.access.mode;
  const provider = state.search.provider;
  const drawn = state.visualize.enabled;
  return [
    ...counted("Providers", lists.providers, PROVIDERS_HREF),
    ...counted("Agents", lists.agents, AGENTS_HREF),
    ...counted("Deciders", lists.deciders, DECIDERS_HREF),
    ...counted("MCP Servers", lists.servers, MCP_HREF),
    ...counted("Skills", lists.skills, SKILLS_HREF),
    {
      label: "Visuals",
      value: drawn ? "On" : "Off",
      href: VISUALS_HREF,
      quiet: !drawn,
    },
    {
      label: "Web access",
      value: MODE_WORDS[mode],
      href: WEB_HREF,
      quiet: mode === "off",
    },
    {
      label: "Search",
      value: provider ?? "None",
      href: WEB_HREF,
      quiet: provider === null,
    },
    ...counted("Credentials", lists.credentials, CREDENTIALS_HREF),
  ];
}
