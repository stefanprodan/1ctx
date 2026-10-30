// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Reading an anthropic Messages body for its cache: the marks in prompt
// order, the body without them, and its messages as one list of blocks
// with their role, which is what a cached prefix compares.

import { expect } from "bun:test";

type Body = Record<string, any>;
export type Mark = { type: string; ttl?: string };

const labelOf = (block: Record<string, any>): string =>
  block.text ?? block.name ?? block.tool_use_id ?? block.type;

export function marksOf(body: Body): { at: string; mark: Mark }[] {
  const out: { at: string; mark: Mark }[] = [];
  for (const block of body.system ?? []) {
    if (block.cache_control)
      out.push({ at: "system", mark: block.cache_control });
  }
  for (const turn of body.messages as { content: Body[] }[]) {
    for (const block of turn.content) {
      if (block.cache_control) {
        out.push({ at: labelOf(block), mark: block.cache_control });
      }
    }
  }
  return out;
}

export function stripMarks(body: Body): Body {
  return JSON.parse(
    JSON.stringify(body, (key, value) =>
      key === "cache_control" ? undefined : value,
    ),
  );
}

// every message block with its role, marks kept
export function flatBlocks(body: Body): Body[] {
  return (body.messages as { role: string; content: Body[] }[]).flatMap(
    (turn) => turn.content.map((block) => ({ role: turn.role, ...block })),
  );
}

// the place of the last block marked for an hour (a channel's stream
// mark) or of the last mark (a chat's tail), -1 for none
export const lastHourAt = (body: Body) =>
  flatBlocks(body).findLastIndex((block) => block.cache_control?.ttl === "1h");
export const lastMarkAt = (body: Body) =>
  flatBlocks(body).findLastIndex((block) => block.cache_control);

// the next request repeats this one's tools, system and blocks through
// `at`, the place of one of its marks, so the cache written there is read
export function expectPrefix(next: Body, first: Body, at: number): void {
  expect(at).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(stripMarks({ t: next.tools }))).toBe(
    JSON.stringify(stripMarks({ t: first.tools })),
  );
  expect(JSON.stringify(stripMarks({ s: next.system }))).toBe(
    JSON.stringify(stripMarks({ s: first.system })),
  );
  const strip = (body: Body) =>
    flatBlocks(stripMarks(body))
      .slice(0, at + 1)
      .map((block) => JSON.stringify(block));
  expect(strip(next)).toEqual(strip(first));
}

// the API's rules: four marks at most, never a shorter life before a
// longer one
export function expectMarkRules(body: Body): void {
  const marks = marksOf(body);
  expect(marks.length).toBeLessThanOrEqual(4);
  const lastHour = marks.findLastIndex((m) => m.mark.ttl === "1h");
  for (const { mark } of marks.slice(0, lastHour + 1)) {
    expect(mark).toEqual({ type: "ephemeral", ttl: "1h" });
  }
}
