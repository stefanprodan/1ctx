// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { PatchToolRequest } from "../../shared/api/tools.ts";
import { MAX_VISUAL_HOSTS, visualOrigin } from "../../shared/visual.ts";
import { isWebAccessMode, parseDomains } from "../../shared/web.ts";
import { isSearchProvider } from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

export type ToolName = "web" | "websearch" | "visualize";

export function parseToolName(value: unknown): ToolName {
  if (value !== "web" && value !== "websearch" && value !== "visualize")
    throw new BadRequest("no such tool");
  return value;
}

export function parseToolPatch(
  body: unknown,
  name?: ToolName,
): PatchToolRequest {
  const allowed =
    name === "web"
      ? ["mode", "domains"]
      : name === "websearch"
        ? ["provider"]
        : name === "visualize"
          ? ["enabled", "hosts"]
          : ["mode", "domains", "enabled", "provider", "hosts"];
  const input = fields(body, allowed);
  const hasEnabled = Object.hasOwn(input, "enabled");
  const hasProvider = Object.hasOwn(input, "provider");
  const hasHosts = Object.hasOwn(input, "hosts");
  const hasMode = Object.hasOwn(input, "mode");
  const hasDomains = Object.hasOwn(input, "domains");
  if (!hasEnabled && !hasProvider && !hasHosts && !hasMode && !hasDomains) {
    throw new BadRequest(`${allowed.join(", ")} is required`);
  }
  const patch: PatchToolRequest = {};
  if (hasEnabled) {
    if (typeof input.enabled !== "boolean") {
      throw new BadRequest("enabled must be a boolean");
    }
    patch.enabled = input.enabled;
  }
  if (hasProvider) {
    if (input.provider !== null && !isSearchProvider(input.provider)) {
      throw new BadRequest("provider must be exa, firecrawl, tavily or null");
    }
    patch.provider = input.provider;
  }
  if (hasHosts) patch.hosts = parseHosts(input.hosts);
  if (hasMode) {
    if (!isWebAccessMode(input.mode))
      throw new BadRequest("mode must be off, all or listed");
    patch.mode = input.mode;
  }
  if (hasDomains) {
    patch.domains = parseWebDomains(input.domains);
  }
  if (patch.mode === "listed" && patch.domains?.length === 0)
    throw new BadRequest("list at least one host");
  return patch;
}

export function parseWebDomains(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((domain) => typeof domain === "string")
  ) {
    throw new BadRequest("domains must be a list of hosts");
  }
  const parsed = parseDomains(value);
  if (!parsed.ok)
    throw new BadRequest(`domains line ${parsed.line} ${parsed.error}`);
  return parsed.domains;
}

export function parseHosts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_VISUAL_HOSTS) {
    throw new BadRequest(
      `hosts must be a list of at most ${MAX_VISUAL_HOSTS} HTTPS origins`,
    );
  }
  const hosts = value.map((host: unknown) => {
    const origin = typeof host === "string" ? visualOrigin(host) : null;
    if (origin === null) {
      throw new BadRequest(
        "hosts must be HTTPS origins without a path, query or custom port",
      );
    }
    return origin;
  });
  return [...new Set(hosts)].sort();
}
