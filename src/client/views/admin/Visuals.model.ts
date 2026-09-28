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

// the Visuals card's line, as its switch is drafted
export function visualsLine(on: boolean): string {
  return on
    ? "Allows agents to draw HTML and SVG visuals."
    : "In-line visualizations are disabled.";
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
