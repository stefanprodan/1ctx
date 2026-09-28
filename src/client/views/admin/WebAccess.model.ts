// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Web access page's tabs, its limits, and the Access card's draft:
// whether it differs from what was saved and the body its Save sends.

import type { PatchToolRequest } from "../../../shared/api/tools.ts";
import type { WebAccess, WebAccessMode } from "../../../shared/web.ts";
import type { LimitName } from "../../../shared/words.ts";
import { domainsOf } from "./Tools.model.ts";

type WebTab = "general" | "credentials";

export const WEB_TABS: { tab: WebTab; label: string; href: string }[] = [
  { tab: "general", label: "General", href: "/admin/config/web" },
  {
    tab: "credentials",
    label: "Credentials",
    href: "/admin/config/web/credentials",
  },
];

export function webTab(pathname: string): WebTab {
  return WEB_TABS.find((t) => t.href === pathname)?.tab ?? "general";
}

// the fetch limits over the search ones, three to a line
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

// the box counts only while Listed domains is picked, since the other
// modes keep the list without reading it
export function accessDirty(
  mode: WebAccessMode,
  typed: string,
  saved: WebAccess,
): boolean {
  if (mode !== saved.mode) return true;
  return mode === "listed" && typed.trim() !== domainsText(saved.domains);
}

// what Save sends, or the words for the box
export function accessBody(
  mode: WebAccessMode,
  typed: string,
): { body: PatchToolRequest } | { error: string } {
  if (mode !== "listed") return { body: { mode } };
  const parsed = domainsOf(typed);
  if ("error" in parsed) return parsed;
  return { body: { mode, domains: parsed.domains } };
}
