// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The in-memory filesystem's walks cost the entries they visit, whatever
// the depth: rm -rf, find and ls -R over a tree four times as deep touch
// the tree's maps about as often per entry. Counted, never timed.

import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";

// defined, not assigned: another suite may freeze Map.prototype, and an
// assignment cannot shadow a frozen inherited method
function define(map: object, name: PropertyKey, value: unknown) {
  Object.defineProperty(map, name, { value, configurable: true });
}

// counts every lookup and iteration step on the filesystem's own maps
function countSteps(fs: InMemoryFs): { steps: number } {
  const counter = { steps: 0 };
  const fields = fs as unknown as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    const map = fields[key];
    if (!(map instanceof Map)) continue;
    const methods = map as unknown as Record<PropertyKey, unknown>;
    for (const name of ["get", "has", "set", "delete"]) {
      const original = map[name as "get"].bind(map);
      define(map, name, (...args: [unknown]) => {
        counter.steps++;
        return original(...args);
      });
    }
    for (const name of ["entries", "keys", "values", Symbol.iterator]) {
      const original = (methods[name] as () => Iterator<unknown>).bind(map);
      define(map, name, function* () {
        for (const item of { [Symbol.iterator]: original }) {
          counter.steps++;
          yield item;
        }
      });
    }
  }
  return counter;
}

// one file at the end of each of `chains` folders `depth` deep
function tree(chains: number, depth: number) {
  const files: Record<string, string> = {};
  for (let c = 0; c < chains; c++) {
    let path = `/t/c${c}`;
    for (let d = 1; d < depth; d++) path += `/d${d}`;
    files[`${path}/f`] = "x";
  }
  const fs = new InMemoryFs(files);
  return { fs, entries: fs.getAllPaths().length };
}

async function stepsPerEntry(script: string, depth: number) {
  const { fs, entries } = tree(50, depth);
  const bash = new Bash({ fs, cwd: "/" });
  const counter = countSteps(fs);
  const r = await bash.exec(`${script} > /dev/null`);
  expect(r.exitCode).toBe(0);
  return counter.steps / entries;
}

describe("the in-memory filesystem's walks", () => {
  for (const script of ["rm -rf /t", "find /t -type f", "ls -R /t"]) {
    test(`${script} costs the same per entry at depth 8 and 32`, async () => {
      const shallow = await stepsPerEntry(script, 8);
      const deep = await stepsPerEntry(script, 32);
      // a scan of every path per folder made this about 3
      expect(deep / shallow).toBeLessThan(1.5);
    });
  }

  test("a path resolves through a symlink made after the files", async () => {
    const bash = new Bash({ files: { "/a/b/f": "x\n" }, cwd: "/" });
    const r = await bash.exec(
      "ln -s /a/b/f /m && cat /m && rm /m && cat /a/b/f && ln -s /a/b /l && cat /l/f",
    );
    expect(r.stdout).toBe("x\nx\nx\n");
    expect(r.exitCode).toBe(0);
  });

  test("readdir lists direct children after moves and removals", async () => {
    const bash = new Bash({ cwd: "/" });
    const r = await bash.exec(
      "mkdir -p /r/a/b /r/c && touch /r/a/b/f /r/x && mv /r/a /r/z && rm -r /r/c && ls /r /r/z && ls -R /r",
    );
    expect(r.stdout).toBe(
      "/r:\nx\nz\n\n/r/z:\nb\n/r:\nx\nz\n\n/r/z:\nb\n\n/r/z/b:\nf\n",
    );
  });
});
