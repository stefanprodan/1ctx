// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { following } from "../../../src/client/transcript/Transcript.model.ts";

// a box at its end: 2000 of rows, 600 in sight
const atEnd = { top: 1400, height: 2000, client: 600 };

test("scrolling up lets go of the end", () => {
  expect(following(true, atEnd, { ...atEnd, top: 1000 })).toBe(false);
});

test("reaching the end follows it again", () => {
  expect(following(false, { ...atEnd, top: 1000 }, atEnd)).toBe(true);
});

test("rows that shrink clamp the top without letting go", () => {
  expect(following(true, atEnd, { top: 1200, height: 1800, client: 600 })).toBe(
    true,
  );
});

test("a box that grows, a keyboard closing, clamps the top without letting go", () => {
  expect(following(true, { top: 1700, height: 2000, client: 300 }, atEnd)).toBe(
    true,
  );
});

test("away from the end a view that let go stays let go", () => {
  const mid = { top: 500, height: 2000, client: 600 };
  expect(following(false, mid, { ...mid, top: 520 })).toBe(false);
});
