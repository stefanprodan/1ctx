// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Tokens typed in whole thousands: a kept value shows rounded and comes
// back exact while its text is unchanged.

import { describe, expect, test } from "bun:test";
import {
  thousandsText,
  thousandsValue,
} from "../../../src/client/lib/thousands.ts";

describe("thousands", () => {
  test("shows tokens rounded to whole thousands", () => {
    expect(thousandsText(131_072)).toBe("131");
    expect(thousandsText(4096)).toBe("4");
    expect(thousandsText(1500)).toBe("2");
    expect(thousandsText(256)).toBe("0");
  });

  test.each([
    { text: "131", kept: [131_072], value: 131_072 },
    { text: " 131 ", kept: [131_072], value: 131_072 },
    { text: "132", kept: [131_072], value: 132_000 },
    { text: "4", kept: [8192, 4096], value: 4096 },
    { text: "8", kept: [8192, 4096], value: 8192 },
    { text: "1,000", kept: [], value: 1_000_000 },
    { text: "1.5", kept: [], value: null },
    { text: "-1", kept: [], value: null },
    { text: "", kept: [4096], value: null },
  ])("reads %p", ({ text, kept, value }) => {
    expect(thousandsValue(text, kept)).toBe(value);
  });
});
