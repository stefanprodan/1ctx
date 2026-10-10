// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  MENU_MAX,
  menuPlace,
} from "../../../src/client/composer/AgentPicker.model.ts";

const chip = (top: number) => ({ top, bottom: top + 32 });

test("the menu opens below its chip when it fits", () => {
  expect(
    menuPlace({ chip: chip(400), top: 100, bottom: 900, height: 200 }),
  ).toEqual({ up: false, maxHeight: MENU_MAX });
});

test("a chip at the window's foot opens its menu above", () => {
  expect(
    menuPlace({ chip: chip(840), top: 100, bottom: 900, height: 200 }),
  ).toEqual({ up: true, maxHeight: MENU_MAX });
});

test("a menu above stops under the page head", () => {
  const place = menuPlace({
    chip: chip(300),
    top: 100,
    bottom: 400,
    height: 400,
  });
  expect(place).toEqual({ up: true, maxHeight: 186 });
});

test("a long list on the side with more room scrolls past it", () => {
  const place = menuPlace({
    chip: chip(500),
    top: 100,
    bottom: 900,
    height: 1700,
  });
  expect(place).toEqual({ up: false, maxHeight: MENU_MAX });
  const short = menuPlace({
    chip: chip(500),
    top: 100,
    bottom: 700,
    height: 1700,
  });
  expect(short).toEqual({ up: true, maxHeight: MENU_MAX });
});

test("a short list stays below while it fits there", () => {
  expect(
    menuPlace({ chip: chip(700), top: 100, bottom: 900, height: 120 }).up,
  ).toBe(false);
});

test("no room on either side gives no negative height", () => {
  expect(
    menuPlace({ chip: chip(100), top: 100, bottom: 132, height: 100 })
      .maxHeight,
  ).toBe(0);
});
