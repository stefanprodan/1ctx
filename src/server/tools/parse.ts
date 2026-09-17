// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { PatchToolRequest } from "../../shared/api/tools.ts";
import {
  isSearchProvider,
  isWebTool,
  type WebTool,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

export function parseToolName(value: unknown): WebTool {
  if (!isWebTool(value)) throw new BadRequest("no such tool");
  return value;
}

export function parseToolPatch(body: unknown): PatchToolRequest {
  const input = fields(body, ["enabled", "provider", "hosts"]);
  const hasEnabled = Object.hasOwn(input, "enabled");
  const hasProvider = Object.hasOwn(input, "provider");
  const hasHosts = Object.hasOwn(input, "hosts");
  if (!hasEnabled && !hasProvider && !hasHosts) {
    throw new BadRequest("enabled, provider or hosts is required");
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
  return patch;
}

export function parseHosts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw new BadRequest("hosts must be a list of at most 16 HTTPS origins");
  }
  const hosts = value.map((host: unknown) => {
    // Check the spelling before URL can erase a path, escape or separator.
    if (
      typeof host !== "string" ||
      !/^https:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::443)?\/?$/i.test(host)
    ) {
      throw new BadRequest(
        "hosts must be HTTPS origins without a path, query or custom port",
      );
    }
    let url: URL;
    try {
      url = new URL(host);
    } catch {
      throw new BadRequest("hosts must be valid HTTPS origins");
    }
    if (
      !url.hostname.startsWith("[") &&
      !url.hostname
        .replace(/\.$/, "")
        .split(".")
        .every(
          (label) =>
            label.length <= 63 &&
            /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
        )
    ) {
      throw new BadRequest("hosts must be valid HTTPS origins");
    }
    return url.origin;
  });
  return [...new Set(hosts)].sort();
}
