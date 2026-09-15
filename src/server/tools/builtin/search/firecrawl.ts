// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Firecrawl wire: a search over its v2 endpoint, answered as JSON.
// Nothing here reads a key file or reaches the network; the area passes
// the key, the version and the deadline, the caller does the request.

import { formatHits, isObject, jsonObject, unexpected } from "./answer.ts";
import {
  ProviderError,
  type ProviderRequest,
  type SearchArgs,
} from "./types.ts";

export const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/search";

// Firecrawl stops its own search at the timeout it is sent; it gets the
// tool's deadline less a margin, so its answer arrives before ours ends
const DEADLINE_MARGIN_MS = 2000;
const MIN_TIMEOUT_MS = 1000;

export function buildRequest(
  args: SearchArgs,
  key: string | null,
  version: string,
  deadlineMs: number,
): ProviderRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": `1ctx/${version}`,
  };
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  return {
    url: FIRECRAWL_URL,
    headers,
    body: JSON.stringify({
      query: args.query,
      limit: 5,
      timeout: Math.max(MIN_TIMEOUT_MS, deadlineMs - DEADLINE_MARGIN_MS),
      ...(args.domain ? { includeDomains: [args.domain] } : {}),
    }),
  };
}

export function parseAnswer(body: string): string {
  const answer = jsonObject(body);
  if (answer.success !== true) {
    if (typeof answer.error === "string") {
      throw new ProviderError(answer.error);
    }
    return unexpected();
  }
  if (!isObject(answer.data)) return unexpected();
  return formatHits(answer.data.web, "description");
}
