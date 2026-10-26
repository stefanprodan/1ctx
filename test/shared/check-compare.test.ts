// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  canonical,
  formatCompare,
  isEmptyValue,
  MAX_CHECK_COMPARE,
  parseCompare,
  valueAt,
} from "../../src/shared/check-compare.ts";

test("a compare is dotted keys, each with array indexes", () => {
  const cases: [string, (string | number)[]][] = [
    ["tag_name", ["tag_name"]],
    [".tag_name", ["tag_name"]],
    ["data.items[0].id", ["data", "items", 0, "id"]],
    ["[0].tag_name", [0, "tag_name"]],
    [".[0].tag_name", [0, "tag_name"]],
    ["[1][2]", [1, 2]],
    ["rows[0][12].a-b_C9", ["rows", 0, 12, "a-b_C9"]],
    ["0.1", ["0", "1"]],
  ];
  for (const [text, path] of cases) expect(parseCompare(text)).toEqual(path);
});

test("a path has one spelling", () => {
  const cases: [string, string][] = [
    [".tag_name", "tag_name"],
    ["data.items[0].id", "data.items[0].id"],
    [".[0].tag_name", "[0].tag_name"],
    ["a[01]", "a[1]"],
  ];
  for (const [text, spelled] of cases) {
    expect(formatCompare(parseCompare(text)!)).toBe(spelled);
  }
});

test("anything else is refused", () => {
  for (const text of [
    "",
    ".",
    "..a",
    "a.",
    "a..b",
    "a.[0]",
    "a[]",
    "a[x]",
    "a[-1]",
    "a[0]b",
    "a b",
    "a/b",
    '"a"',
    "$.a",
    "a[0",
    "a[1234567890]",
    "é",
    `a${".b".repeat(MAX_CHECK_COMPARE)}`,
  ]) {
    expect(parseCompare(text)).toBeNull();
  }
});

test("a value is found only where the answer holds it", () => {
  const json = {
    tag_name: "v2.1.0",
    assets: [{ name: "a", download_count: 7 }],
    nested: [[1, 2]],
  };
  const at = (text: string) => valueAt(json, parseCompare(text)!);
  expect(at("tag_name")).toBe("v2.1.0");
  expect(at("assets[0].name")).toBe("a");
  expect(at("nested[0][1]")).toBe(2);
  for (const missing of [
    "name",
    "assets[1]",
    "assets.name",
    "tag_name.x",
    "tag_name[0]",
    "[0]",
    "nested[0][2]",
    "toString",
  ]) {
    expect(at(missing)).toBeUndefined();
  }
  expect(valueAt([{ id: 1 }], parseCompare("[0].id")!)).toBe(1);
  expect(valueAt({ a: null }, ["a"])).toBeNull();
});

test("null, empty text, [] and {} are empty; false and 0 are not", () => {
  for (const value of [null, "", [], {}])
    expect(isEmptyValue(value)).toBe(true);
  for (const value of [false, 0, " ", [null], { a: null }]) {
    expect(isEmptyValue(value)).toBe(false);
  }
});

test("a canonical value sorts every object's keys", () => {
  expect(canonical({ b: 1, a: [{ d: 2, c: "x" }] })).toBe(
    canonical({ a: [{ c: "x", d: 2 }], b: 1 }),
  );
  expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  expect(canonical([2, 1])).not.toBe(canonical([1, 2]));
  expect(canonical("v1")).toBe('"v1"');
});
