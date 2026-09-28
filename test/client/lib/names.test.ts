// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A name field shows the shaped name as it is typed and hands the same
// value to its form.

import { describe, expect, test } from "bun:test";
import {
  nameProblem,
  nameTaken,
  shapedInput,
} from "../../../src/client/lib/names.ts";

const typed = (value: string) => {
  const box = { value };
  return { box, event: { currentTarget: box } as unknown as Event };
};

describe("shapedInput", () => {
  test.each([
    ["Q3 Launch", "q3-launch"],
    ["stefan.prodan", "stefan-prodan"],
    ["on_call", "on_call"],
    ["ops@home", "opshome"],
  ])("%s becomes %s in the box and the form", (value, shaped) => {
    const { box, event } = typed(value);
    expect(shapedInput(event)).toBe(shaped);
    expect(box.value).toBe(shaped);
  });
});

describe("nameProblem", () => {
  test.each(["", " ", "  "])("%p is an empty name", (value) => {
    expect(nameProblem(value)).toBe("Enter a name");
  });

  test.each(["coder", "platform", " platform ", "a", "platform.team"])(
    "%p is left to the server",
    (value) => {
      expect(nameProblem(value)).toBeNull();
    },
  );
});

test("a name is taken by another row or a reserved name", () => {
  const rows = [
    { id: "a1", name: "coder" },
    { id: "a2", name: "writer" },
  ];
  expect(nameTaken(rows, "writer", "a1")).toBe(true);
  expect(nameTaken(rows, " writer ")).toBe(true);
  expect(nameTaken(rows, "writer", "a2")).toBe(false);
  expect(nameTaken(rows, "ops")).toBe(false);
  expect(nameTaken(null, "writer")).toBe(false);
  expect(nameTaken(rows, "personal", "", ["personal"])).toBe(true);
});
