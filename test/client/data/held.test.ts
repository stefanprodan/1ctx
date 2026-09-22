// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { Held } from "../../../src/client/data/held.ts";

describe("held answers", () => {
  test("the value used least recently goes past the size", () => {
    const held = new Held<number>(2);
    held.set("a", 1);
    held.set("b", 2);
    expect(held.get("a")).toBe(1);
    held.set("c", 3);
    expect(held.get("b")).toBeUndefined();
    expect(held.get("a")).toBe(1);
    expect(held.get("c")).toBe(3);
  });

  test("update keeps, replaces or drops each entry", () => {
    const held = new Held<number>();
    held.set("a", 1);
    held.set("b", 2);
    held.set("c", 3);
    held.update((n, key) => (key === "b" ? null : n === 3 ? 30 : n));
    expect(held.get("a")).toBe(1);
    expect(held.get("b")).toBeUndefined();
    expect(held.get("c")).toBe(30);
  });

  test("delete and clear forget", () => {
    const held = new Held<number>();
    held.set("a", 1);
    held.set("b", 2);
    held.delete("a");
    expect(held.get("a")).toBeUndefined();
    held.clear();
    expect(held.get("b")).toBeUndefined();
  });
});
