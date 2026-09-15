// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Token counts are o200k_base's: recorded counts for fixed text, so a
// package upgrade that moves them fails here.

import { describe, expect, test } from "bun:test";
import { tokens } from "../../../src/server/lib/tokens.ts";

describe("tokens", () => {
  test("counts in o200k_base", () => {
    expect(tokens("")).toBe(0);
    expect(tokens("hello world")).toBe(2);
    expect(tokens("You are a senior software tester.")).toBe(7);
  });
});
