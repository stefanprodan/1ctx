// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The layout rules over src/ and test/, and every fixture root under
// test/fixtures/structure/ rejected for the rule its name says.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { check, networkCheck } from "./structure.ts";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(import.meta.dir, "fixtures", "structure");

describe("the layout", () => {
  test("src/ follows the rules", () => {
    expect(check(join(ROOT, "src"))).toEqual([]);
  });

  test("no test names a provider host", () => {
    expect(networkCheck(import.meta.dir)).toEqual([]);
  });

  test("a visual palette belongs only to visual-theme.ts", () => {
    expect(
      check(join(FIXTURES, "tokens-visual-shell")).map((v) => v.file),
    ).toEqual(["server/tools/visual-shell.ts"]);
  });

  for (const name of readdirSync(FIXTURES).sort()) {
    const rule = name.split("-")[0];
    test(`fixture ${name} is rejected for ${rule}`, () => {
      const dir = join(FIXTURES, name);
      const violations =
        rule === "network" ? networkCheck(join(dir, "test")) : check(dir);
      // rejected for that rule and nothing else, so a fixture cannot
      // pass by accident
      expect(violations.length).toBeGreaterThan(0);
      expect(new Set(violations.map((v) => v.rule))).toEqual(new Set([rule]));
    });
  }
});
