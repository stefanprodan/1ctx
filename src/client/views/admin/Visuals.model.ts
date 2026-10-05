// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { LimitName } from "../../../shared/contracts/limit.ts";
import { DEFAULT_VISUAL_HOSTS } from "../../../shared/contracts/tool.ts";
import { parseVisualHosts } from "../../../shared/visual.ts";
import { lineError } from "./Tools.model.ts";

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

export function hostsLine(hosts: readonly string[]): string {
  return hosts.length === 0
    ? "No CDNs. Visuals use inline code only."
    : "Visuals load scripts, styles and fonts only from these CDNs.";
}

export function defaultHosts(hosts: readonly string[]): boolean {
  return (
    hosts.length === DEFAULT_VISUAL_HOSTS.length &&
    DEFAULT_VISUAL_HOSTS.every((host, i) => hosts[i] === host)
  );
}

export function hostsOf(text: string): { hosts: string[] } | { error: string } {
  const result = parseVisualHosts(text.split("\n"));
  if (!result.ok) {
    return { error: lineError(result) };
  }
  return { hosts: result.hosts };
}

export function hostsFieldOf(message: string): "hosts" | undefined {
  return message.startsWith("hosts ") ? "hosts" : undefined;
}
