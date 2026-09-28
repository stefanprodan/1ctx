// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the Config board shows without a DOM: its tabs, the limits of
// each card on Limits and Storage, and for each built-in tool whether
// a turn is offered it.

import type { ToolsResponse } from "../../../shared/api/tools.ts";
import type {
  BuiltinToolSummary,
  WebToolSummary,
} from "../../../shared/contracts/tool.ts";
import type { LimitName } from "../../../shared/words.ts";

type ConfigTab = "overview" | "limits" | "storage";

export const CONFIG_TABS: { tab: ConfigTab; label: string; href: string }[] = [
  { tab: "overview", label: "Overview", href: "/admin/config" },
  { tab: "limits", label: "Limits", href: "/admin/config/limits" },
  { tab: "storage", label: "Storage", href: "/admin/config/storage" },
];

export function configTab(pathname: string): ConfigTab {
  return CONFIG_TABS.find((t) => t.href === pathname)?.tab ?? "overview";
}

// a card of limits: its title, its line and its fields in order
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
      "sendDeadlineMs",
    ],
  },
  {
    title: "Automations",
    line: "How long runs take and how many go at once.",
    names: [
      "runDeadlineMs",
      "runsPerUser",
      "runsRunning",
      "memoryPhaseMs",
      "memoryPhaseRounds",
    ],
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
];

type AnyTool = BuiltinToolSummary | WebToolSummary;

// every built-in in one list, visualize with them, by name
export function builtinsOf(state: ToolsResponse): AnyTool[] {
  return [...state.builtin, state.visualize].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

// whether a turn may be offered the tool: the web tools follow web
// access and the search provider, visualize its switch, the rest follow
// what the turn has
export function offered(tool: AnyTool, state: ToolsResponse): boolean {
  if (tool.name === "webfetch") return state.access.mode !== "off";
  if (tool.name === "websearch") {
    return state.access.mode !== "off" && state.search.provider !== null;
  }
  if (tool.name === "visualize") return state.visualize.enabled;
  return true;
}

// a line of the aside: what it counts or names, and the page it opens
export type InstanceLine = {
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

// the aside's Instance: how many of each thing the instance has, a list
// not loaded yet left out, with what turns get from visuals and the web
// before the credentials, which belong to web access
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
    ...counted("Providers", lists.providers, "/admin/config/providers"),
    ...counted("Agents", lists.agents, "/admin/config/agents"),
    ...counted("Deciders", lists.deciders, "/admin/config/deciders"),
    ...counted("MCP servers", lists.servers, "/admin/config/mcp"),
    ...counted("Skills", lists.skills, "/admin/config/skills"),
    {
      label: "Visuals",
      value: drawn ? "On" : "Off",
      href: "/admin/config/visuals",
      quiet: !drawn,
    },
    {
      label: "Web access",
      value: MODE_WORDS[mode],
      href: "/admin/config/web",
      quiet: mode === "off",
    },
    {
      label: "Search",
      value: provider ?? "None",
      href: "/admin/config/web",
      quiet: provider === null,
    },
    ...counted(
      "Credentials",
      lists.credentials,
      "/admin/config/web/credentials",
    ),
  ];
}
