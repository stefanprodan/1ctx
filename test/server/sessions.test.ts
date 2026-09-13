// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { lineFrom } from "../../src/server/sessions/index.ts";

type Fixture = {
  name: string;
  input: string;
  repeat?: number;
  expected?: string;
  expectedRepeat?: number;
  suffix?: string;
};

const fixtures = (await Bun.file(
  new URL("../fixtures/sessions/last-lines.json", import.meta.url),
).json()) as Fixture[];

describe("lineFrom", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      const input = fixture.input.repeat(fixture.repeat ?? 1);
      const expected =
        fixture.expected ??
        `${fixture.input.repeat(fixture.expectedRepeat ?? 0)}${fixture.suffix}`;
      expect(lineFrom(input)).toBe(expected);
    });
  }
});
