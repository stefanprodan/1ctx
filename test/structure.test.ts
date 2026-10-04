// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The layout rules over src/ and test/, and every fixture root under
// test/fixtures/structure/ rejected for the rule its name says.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { check, colourLiterals, docsCheck, networkCheck } from "./structure.ts";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(import.meta.dir, "fixtures", "structure");

describe("the layout", () => {
  test("src/ follows the rules", () => {
    expect(check(join(ROOT, "src"))).toEqual([]);
  });

  test("no test names a provider host", () => {
    expect(networkCheck(import.meta.dir)).toEqual([]);
  });

  test("no doc is over the token cap", () => {
    expect(docsCheck(ROOT)).toEqual([]);
  });

  test("a wire named like a colour is no colour literal in code", () => {
    const code = [
      'wire: "azure",',
      'wire === "azure"',
      'name: "azure",',
      '<NewProvider wire="azure" />',
      'const next: Wire = "azure";',
      'function f(w: Wire = "azure") {}',
      'if (wire !== "azure") {}',
    ].join("\n");
    expect(colourLiterals(code, true)).toEqual([]);
    expect(colourLiterals('wire: "azure",\ncolor: "teal"', true)).toEqual([2]);
    // as a style or an attribute it is the colour, and markup has no wire
    expect(colourLiterals('style={{ color: "azure" }}', true)).toEqual([1]);
    expect(colourLiterals('<rect fill="azure"/>', true)).toEqual([1]);
    expect(colourLiterals('const tint: Colour = "azure";', true)).toEqual([1]);
    expect(colourLiterals('<Box color="azure" />', true)).toEqual([1]);
    expect(colourLiterals('wire: "azure"')).toEqual([1]);
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
        rule === "network"
          ? networkCheck(join(dir, "test"))
          : rule === "docs"
            ? docsCheck(dir)
            : check(dir);
      // rejected for that rule and nothing else, so a fixture cannot
      // pass by accident
      expect(violations.length).toBeGreaterThan(0);
      expect(new Set(violations.map((v) => v.rule))).toEqual(new Set([rule]));
    });
  }
});
