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
  const input = fields(body, ["enabled", "provider"]);
  const hasEnabled = Object.hasOwn(input, "enabled");
  const hasProvider = Object.hasOwn(input, "provider");
  if (!hasEnabled && !hasProvider) {
    throw new BadRequest("enabled or provider is required");
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
  return patch;
}
