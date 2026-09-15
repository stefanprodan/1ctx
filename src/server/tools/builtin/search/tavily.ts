// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Tavily wire: a basic search, answered as JSON. Without a key the
// request asks for keyless access by header. Nothing here reads a key
// file or reaches the network; the area passes the key and the version,
// the caller does the request.

import { formatHits, jsonObject } from "./answer.ts";
import type { ProviderRequest, SearchArgs } from "./types.ts";

export const TAVILY_URL = "https://api.tavily.com/search";

export function buildRequest(
  args: SearchArgs,
  key: string | null,
  version: string,
): ProviderRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": `1ctx/${version}`,
  };
  if (key === null) headers["X-Tavily-Access-Mode"] = "keyless";
  else headers.Authorization = `Bearer ${key}`;
  return {
    url: TAVILY_URL,
    headers,
    body: JSON.stringify({
      query: args.query,
      max_results: 5,
      ...(args.domain ? { include_domains: [args.domain] } : {}),
    }),
  };
}

export function parseAnswer(body: string): string {
  return formatHits(jsonObject(body).results, "content");
}
