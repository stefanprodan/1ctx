// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_VISUAL_HOSTS } from "../../../shared/contracts/tool.ts";
import type { LimitName } from "../../../shared/words.ts";
import { defaultHosts, hostsOf } from "./Tools.model.ts";

export const VISUAL_LIMITS: readonly LimitName[] = [
  "visualBytes",
  "visualSendBytes",
  "maxVisuals",
];

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

export function isDefaultHosts(text: string): boolean {
  const parsed = hostsOf(text);
  return !("error" in parsed) && defaultHosts(parsed.hosts);
}
