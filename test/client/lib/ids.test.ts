// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { sameIds, toggledId } from "../../../src/client/lib/ids.ts";

test("the same ids in any order, and one flipped", () => {
  expect(sameIds(["a", "b"], ["b", "a"])).toBe(true);
  expect(sameIds(["a", "b"], ["a"])).toBe(false);
  expect(sameIds(["a", "b"], ["a", "a"])).toBe(false);
  expect(toggledId(["a", "b"], "a")).toEqual(["b"]);
  expect(toggledId(["b"], "a")).toEqual(["b", "a"]);
});
