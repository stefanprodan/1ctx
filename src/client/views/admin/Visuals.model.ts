// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Visuals page's words and drafts: what the switch means, the CDN
// box as text and whether it differs from what was saved or from the
// defaults, and the limits its card holds.

import { DEFAULT_VISUAL_HOSTS } from "../../../shared/contracts/tool.ts";
import type { LimitName } from "../../../shared/words.ts";
import { defaultHosts, hostsOf } from "./Tools.model.ts";

export const VISUAL_LIMITS: readonly LimitName[] = [
  "visualBytes",
  "visualSendBytes",
  "maxVisuals",
];

// the saved state: what an agent and `open` do with HTML and SVG
export function visualsLine(on: boolean): string {
  return on
    ? "Agents may draw HTML and SVG visuals, and open draws HTML and SVG files."
    : "No agent draws visuals, and open shows HTML and SVG files as code.";
}

export function hostsText(
  hosts: readonly string[] = DEFAULT_VISUAL_HOSTS,
): string {
  return hosts.join("\n");
}

export function hostsDirty(text: string, saved: readonly string[]): boolean {
  return text.trim() !== hostsText(saved);
}

// the box holds the list a fresh instance starts with
export function isDefaultHosts(text: string): boolean {
  const parsed = hostsOf(text);
  return !("error" in parsed) && defaultHosts(parsed.hosts);
}
