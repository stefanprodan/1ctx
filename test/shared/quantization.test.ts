// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  FOUR_BIT,
  isFourBitTag,
  NOT_FOUR_BIT,
  QUANTIZATIONS,
} from "../../src/shared/quantization.ts";

test("a tag is 4-bit by the precision after its slash", () => {
  for (const tag of ["deepinfra/fp4", "a/int4", "a/MXFP4", "a/nvfp4"]) {
    expect(isFourBitTag(tag)).toBe(true);
  }
  for (const tag of ["relace", "fp4", "baseten/fp8", "a/fp4x", "cloudflare"]) {
    expect(isFourBitTag(tag)).toBe(false);
  }
});

test("the allowed precisions are every one but 4 bits", () => {
  expect([...NOT_FOUR_BIT, ...FOUR_BIT].sort()).toEqual(
    [...QUANTIZATIONS].sort(),
  );
  expect(NOT_FOUR_BIT).toContain("unknown");
});
