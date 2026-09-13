// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One test per body a parser must refuse, named after the body with
// long strings cut short: the tables hold values over the caps, and a
// reporter that prints every test name would print them whole.

import { expect, test } from "bun:test";
import { BadRequest } from "../../src/server/lib/errors.ts";

const CUT = 24;

function short(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, (_key, v) =>
    typeof v === "string" && v.length > CUT
      ? `${v.slice(0, 8)}…(${v.length} chars)`
      : v,
  );
}

export function refuses(
  bodies: readonly unknown[],
  parse: (body: unknown) => unknown,
): void {
  for (const body of bodies) {
    test(`refuses ${short(body)}`, () => {
      expect(() => parse(body)).toThrow(BadRequest);
    });
  }
}
