// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the search wires share when they read an answer: the shape error,
// a JSON object, and the numbered hit list the model reads.

export function unexpected(): never {
  throw new Error("websearch answered with an unexpected shape");
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// the body as a JSON object; the parse alone sits in the try, so only a
// syntax error becomes the shape error
export function jsonObject(body: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return unexpected();
  }
  return isObject(value) ? value : unexpected();
}

// one entry per hit with a URL, numbered without gaps: the title, the
// URL and the excerpt the wire names, empty when it is not a string
export function formatHits(hits: unknown, excerpt: string): string {
  if (!Array.isArray(hits)) return unexpected();
  const results: string[] = [];
  for (const hit of hits) {
    if (!isObject(hit) || typeof hit.url !== "string") continue;
    const title = typeof hit.title === "string" ? hit.title : "";
    const text = typeof hit[excerpt] === "string" ? hit[excerpt] : "";
    results.push(`${results.length + 1}. ${title}\n${hit.url}\n${text}`);
  }
  return results.length === 0 ? "No results." : results.join("\n\n");
}
