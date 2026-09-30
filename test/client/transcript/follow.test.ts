// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { followRows } from "../../../src/client/transcript/follow.ts";

test("a view that follows the end follows growth", () => {
  expect(followRows({ stick: true, toggled: false, gap: 300 })).toEqual({
    toEnd: true,
    stick: true,
    jumpHidden: true,
  });
});

test("an opened fold that grows past the view is not followed", () => {
  expect(followRows({ stick: true, toggled: true, gap: 300 })).toEqual({
    toEnd: false,
    stick: false,
    jumpHidden: false,
  });
});

test("a toggled fold that leaves the end in view keeps following", () => {
  expect(followRows({ stick: true, toggled: true, gap: 0 })).toEqual({
    toEnd: false,
    stick: true,
    jumpHidden: true,
  });
});

test.each([
  [false, 300, false, false],
  [false, 60, false, true],
  [true, 20, true, true],
])("a view that let go, toggled %p, gap %p", (toggled, gap, stick, hidden) => {
  expect(followRows({ stick: false, toggled, gap })).toEqual({
    toEnd: false,
    stick,
    jumpHidden: hidden,
  });
});
