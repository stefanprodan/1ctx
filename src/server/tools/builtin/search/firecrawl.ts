// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Firecrawl wire: a search over its v2 endpoint, answered as JSON.
// Nothing here reads a key file or reaches the network; the area passes
// the key and the version, the caller does the request.

import {
  ProviderError,
  type ProviderRequest,
  type SearchArgs,
} from "./types.ts";

function unexpected(): never {
  throw new Error("websearch answered with an unexpected shape");
}

export const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/search";

export function buildRequest(
  args: SearchArgs,
  key: string | null,
  version: string,
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
      timeout: 8000,
      ...(args.domain ? { includeDomains: [args.domain] } : {}),
    }),
  };
}

export function parseAnswer(
  body: string,
  _contentType: string | null,
  _keySent: boolean,
): string {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return unexpected();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return unexpected();
  }
  const answer = value as Record<string, unknown>;
  if (answer.success !== true) {
    if (typeof answer.error === "string") {
      throw new ProviderError(answer.error);
    }
    return unexpected();
  }
  const data = answer.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return unexpected();
  }
  const web = (data as Record<string, unknown>).web;
  if (!Array.isArray(web)) return unexpected();
  const results: string[] = [];
  for (const hit of web) {
    if (typeof hit !== "object" || hit === null || Array.isArray(hit)) continue;
    const item = hit as Record<string, unknown>;
    if (typeof item.url !== "string") continue;
    const title = typeof item.title === "string" ? item.title : "";
    const description =
      typeof item.description === "string" ? item.description : "";
    results.push(
      `${results.length + 1}. ${title}\n${item.url}\n${description}`,
    );
  }
  return results.length === 0 ? "No results." : results.join("\n\n");
}
