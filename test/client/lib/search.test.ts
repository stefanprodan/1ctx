// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { matches } from "../../../src/client/lib/search.ts";

describe("matches", () => {
  test("keeps a row when any field holds the query, in any case", () => {
    const fields = ["bogdan", "Bogdan Patrascoiu", "bogdan@1ctx.dev"];
    expect(matches("", fields)).toBe(true);
    expect(matches("   ", fields)).toBe(true);
    expect(matches("PATRA", fields)).toBe(true);
    expect(matches(" 1ctx.dev ", fields)).toBe(true);
    expect(matches("elena", fields)).toBe(false);
    expect(matches("x", [])).toBe(false);
  });
});
