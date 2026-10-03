// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { placeOf } from "../../../src/client/ui/Finder.model.ts";

const button = { top: 100, bottom: 132, left: 200, right: 300 };
const view = { width: 1440, height: 900 };
const still = { top: 0, left: 0 };

test("the panel hangs under its button", () => {
  expect(
    placeOf({ button, frame: still, view, width: 280, align: "left" }),
  ).toEqual({ top: 136, left: 200, width: 280, maxHeight: 360 });
});

test("a right-aligned panel ends at the button's right edge", () => {
  expect(
    placeOf({ button, frame: still, view, width: 280, align: "right" }).left,
  ).toBe(20);
});

test("the panel stays inside the window's gutter", () => {
  const phone = { width: 390, height: 844 };
  const place = placeOf({
    button: { top: 100, bottom: 132, left: 300, right: 380 },
    frame: still,
    view: phone,
    width: null,
    align: "left",
  });
  expect([place.left, place.width]).toEqual([16, 358]);
});

test("a moved shell holds the panel, so its corner comes off the place", () => {
  const moved = placeOf({
    button,
    frame: { top: 300, left: 0 },
    view,
    width: 280,
    align: "left",
  });
  expect(moved.top).toBe(136 - 300);
  expect(moved.maxHeight).toBe(360);
  expect(
    placeOf({
      button,
      frame: { top: 0, left: 40 },
      view,
      width: 280,
      align: "left",
    }).left,
  ).toBe(160);
});

test("a button near the window's bottom gets the least height", () => {
  expect(
    placeOf({
      button: { top: 800, bottom: 832, left: 200, right: 300 },
      frame: still,
      view,
      width: 280,
      align: "left",
    }).maxHeight,
  ).toBe(160);
});

test("a keyboard's top bounds the panel, not the window's bottom", () => {
  const visible = { width: 402, height: 420 };
  expect(
    placeOf({
      button: { top: 160, bottom: 192, left: 16, right: 116 },
      frame: still,
      view: visible,
      width: null,
      align: "left",
    }).maxHeight,
  ).toBe(420 - 196 - 16);
});
