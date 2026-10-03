// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { frameOf, MIN_SHELL } from "../../../src/client/lib/viewport.ts";

const LAYOUT = 874;
const WHOLE = { height: null, top: 0 };

test("a visual viewport as tall as the layout leaves the shell alone", () => {
  expect(frameOf(LAYOUT, { height: LAYOUT, scale: 1, pageTop: 0 })).toEqual(
    WHOLE,
  );
});

test("a keyboard sizes the shell to what is left above it", () => {
  expect(frameOf(LAYOUT, { height: 520.5, scale: 1, pageTop: 0 })).toEqual({
    height: 520.5,
    top: 0,
  });
});

test("a page the browser scrolled to show the field moves the shell along", () => {
  expect(frameOf(LAYOUT, { height: 520, scale: 1, pageTop: 354 })).toEqual({
    height: 520,
    top: 354,
  });
});

test("a rounding difference is not a keyboard", () => {
  expect(
    frameOf(LAYOUT, { height: LAYOUT - 0.5, scale: 1, pageTop: 0 }),
  ).toEqual(WHOLE);
});

test("a taller visual viewport, the browser's bars gone, is no keyboard", () => {
  expect(
    frameOf(LAYOUT, { height: LAYOUT + 60, scale: 1, pageTop: 0 }),
  ).toEqual(WHOLE);
});

test("a pinch zoom moves nothing", () => {
  expect(frameOf(LAYOUT, { height: 437, scale: 2, pageTop: 200 })).toEqual(
    WHOLE,
  );
});

test("a visible area too short for the head and the composer is the browser's", () => {
  expect(frameOf(402, { height: 60, scale: 1, pageTop: 300 })).toEqual(WHOLE);
  expect(frameOf(402, { height: MIN_SHELL - 1, scale: 1, pageTop: 0 })).toEqual(
    WHOLE,
  );
  expect(frameOf(402, { height: MIN_SHELL, scale: 1, pageTop: 0 }).height).toBe(
    MIN_SHELL,
  );
});

test("a rotation with the keyboard up takes the new height", () => {
  const portrait = frameOf(874, { height: 520, scale: 1, pageTop: 0 });
  const landscape = frameOf(402, { height: 230, scale: 1, pageTop: 0 });
  expect([portrait.height, landscape.height]).toEqual([520, 230]);
});
