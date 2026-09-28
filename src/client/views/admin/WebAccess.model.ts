// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { PatchToolRequest } from "../../../shared/api/tools.ts";
import type { SearchState } from "../../../shared/contracts/tool.ts";
import {
  MAX_WEB_DOMAINS,
  parseDomains,
  type WebAccess,
  type WebAccessMode,
} from "../../../shared/web.ts";
import type { LimitName, SearchProvider } from "../../../shared/words.ts";
import { CREDENTIALS_HREF, WEB_HREF } from "../../lib/hrefs.ts";
import { hostsCount, lineError } from "./Tools.model.ts";

type WebTab = "general" | "credentials";

export const WEB_TABS: { tab: WebTab; label: string; href: string }[] = [
  { tab: "general", label: "General", href: WEB_HREF },
  { tab: "credentials", label: "Credentials", href: CREDENTIALS_HREF },
];

export function webTab(pathname: string): WebTab {
  return WEB_TABS.find((t) => t.href === pathname)?.tab ?? "general";
}

export const WEB_LIMITS: readonly LimitName[] = [
  "maxFetches",
  "fetchBodyBytes",
  "fetchDeadlineMs",
  "maxSearches",
  "searchBodyBytes",
  "searchDeadlineMs",
];

export function domainsText(domains: readonly string[]): string {
  return domains.join("\n");
}

// the other modes keep the list without reading it
export function accessDirty(
  mode: WebAccessMode,
  typed: string,
  saved: WebAccess,
): boolean {
  if (mode !== saved.mode) return true;
  return mode === "listed" && typed.trim() !== domainsText(saved.domains);
}

export function accessBody(
  mode: WebAccessMode,
  typed: string,
): { body: PatchToolRequest } | { error: string } {
  if (mode !== "listed") return { body: { mode } };
  const parsed = domainsOf(typed);
  if ("error" in parsed) return parsed;
  return { body: { mode, domains: parsed.domains } };
}

export const ACCESS_MODES: { value: WebAccessMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "all", label: "All domains" },
  { value: "listed", label: "Listed domains" },
];

export const ACCESS_WORDS: Record<WebAccessMode, string> = {
  off: "Agents cannot fetch pages, search the web or use curl.",
  all: "Agents fetch pages, search the web and use curl in bash, on any address this server reaches.",
  listed: "Agents fetch pages and use curl in bash, only on these hosts.",
};

// sorted as a save stores them
export const DOMAINS_PLACEHOLDER = [
  "api.github.com",
  "codeload.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
].join("\n");

export function boxRows(typed: string): number {
  const lines = (text: string) => text.split("\n").length;
  return Math.max(lines(DOMAINS_PLACEHOLDER), lines(typed)) + 1;
}

export const DOMAINS_HINT =
  "One host per line. A subdomain needs its own line.";

function domainsOf(text: string): { domains: string[] } | { error: string } {
  const result = parseDomains(text.split("\n"));
  if (!result.ok) {
    return { error: lineError(result) };
  }
  if (result.domains.length === 0) return { error: "List at least one host." };
  return { domains: result.domains };
}

export function domainsFieldOf(message: string): "domains" | undefined {
  return message.startsWith("domains ") || message.includes("host")
    ? "domains"
    : undefined;
}

// every provider answers without a key: a missing file is a rate, not
// a fault
export function searchKeyLine(
  provider: SearchProvider,
  present: boolean,
): string {
  return `search-${provider}.key ${present ? "present" : "keyless"}`;
}

export function searchLine(state: SearchState, mode: WebAccessMode): string {
  if (mode === "off") return "Web access is off. websearch is not offered.";
  if (state.provider === null) return "websearch is not offered.";
  const line = `websearch runs on ${state.provider}`;
  if (!state.keys[state.provider]) {
    const key = `search-${state.provider}.key`;
    return `${line} keyless. Add ${key} for a higher rate.`;
  }
  return `${line}.`;
}

// the lines typed while the box does not parse
export function domainsCount(typed: string): string {
  const parsed = parseDomains(typed.split("\n"));
  const n = parsed.ok ? parsed.domains.length : hostsCount(typed);
  return `${n} of ${MAX_WEB_DOMAINS}`;
}
