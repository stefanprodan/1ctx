// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { frameOf } from "../../../src/client/lib/viewport.ts";

const LAYOUT = 874;

test("a visual viewport as tall as the layout leaves the shell alone", () => {
  expect(frameOf(LAYOUT, { height: LAYOUT, scale: 1, pageTop: 0 })).toEqual({
    height: null,
    toTop: false,
  });
});

test("a keyboard sizes the shell to what is left above it", () => {
  expect(frameOf(LAYOUT, { height: 520.5, scale: 1, pageTop: 0 })).toEqual({
    height: 520.5,
    toTop: false,
  });
});

test("a page the browser scrolled to show the field goes back to its top", () => {
  expect(frameOf(LAYOUT, { height: 520, scale: 1, pageTop: 354 })).toEqual({
    height: 520,
    toTop: true,
  });
});

test("a rounding difference is not a keyboard", () => {
  expect(
    frameOf(LAYOUT, { height: LAYOUT - 0.5, scale: 1, pageTop: 0 }).height,
  ).toBeNull();
});

test("a taller visual viewport, the browser's bars gone, is no keyboard", () => {
  expect(
    frameOf(LAYOUT, { height: LAYOUT + 60, scale: 1, pageTop: 0 }).height,
  ).toBeNull();
});

test("a pinch zoom moves nothing", () => {
  expect(frameOf(LAYOUT, { height: 437, scale: 2, pageTop: 200 })).toEqual({
    height: null,
    toTop: false,
  });
});

test("a rotation with the keyboard up takes the new height", () => {
  const portrait = frameOf(874, { height: 520, scale: 1, pageTop: 0 });
  const landscape = frameOf(402, { height: 180, scale: 1, pageTop: 0 });
  expect([portrait.height, landscape.height]).toEqual([520, 180]);
});
