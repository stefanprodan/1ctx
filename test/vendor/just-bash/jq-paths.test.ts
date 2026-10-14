// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// jq assignments, del and path() through the vendored engine, against
// what jq 1.8 prints for the same input; null expects an error.

import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";
import { CASES } from "./jq-paths.cases.ts";
import { countWork, expectLinear } from "./work.ts";

describe("jq path expressions", () => {
  for (const [input, filter, outputs] of CASES) {
    test(filter, async () => {
      const fs = new InMemoryFs();
      await fs.writeFile("/in.json", JSON.stringify(input));
      const result = await new Bash({ fs }).exec('jq -c "$F" /in.json', {
        env: { F: filter },
      });
      if (outputs === null) {
        expect(result.exitCode).not.toBe(0);
        return;
      }
      expect(result.stderr).toBe("");
      const lines = result.stdout.trim().split("\n");
      expect(lines.map((line) => JSON.parse(line))).toEqual(outputs);
    });
  }

  // a writer that copied the array for each element was quadratic
  test.serial("an update over a large array stays linear", async () => {
    const update = async (length: number) => {
      const fs = new InMemoryFs();
      const items = Array.from({ length }, (_, i) => ({ i }));
      await fs.writeFile("/in.json", JSON.stringify(items));
      const bash = new Bash({ fs });
      return countWork(() =>
        bash.exec("jq '.[] |= (.i += 1) | length' /in.json"),
      );
    };
    const eighth = await update(2_500);
    const full = await update(20_000);
    expect(full.result.stdout).toBe("20000\n");
    expectLinear(eighth.work, full.work);
  });

  test("an update keeps a value it placed twice apart", async () => {
    const fs = new InMemoryFs();
    await fs.writeFile("/in.json", '{"a":{"b":{"c":1}}}');
    const result = await new Bash({ fs }).exec(
      `jq -c '(.a.b.c, .a, .a.b.d) |= (if type == "object" and has("b") then {b: .b, b2: .b} else 9 end)' /in.json`,
    );
    expect(result.stdout).toBe('{"a":{"b":{"c":9,"d":9},"b2":{"c":9}}}\n');
  });
});
