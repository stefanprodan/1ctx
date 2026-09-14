// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A name field shows the shaped name as it is typed and hands the same
// value to its form.

import { describe, expect, test } from "bun:test";
import { shapedInput } from "../../../src/client/lib/names.ts";

const typed = (value: string) => {
  const box = { value };
  return { box, event: { currentTarget: box } as unknown as Event };
};

describe("shapedInput", () => {
  test.each([
    ["Q3 Launch", "q3-launch"],
    ["stefan.prodan", "stefan-prodan"],
    ["on_call", "on_call"],
    ["ops@home", "ops@home"],
  ])("%s becomes %s in the box and the form", (value, shaped) => {
    const { box, event } = typed(value);
    expect(shapedInput(event)).toBe(shaped);
    expect(box.value).toBe(shaped);
  });
});
