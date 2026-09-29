// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// diff's own compare: its answers are smallest where the search is not cut
// short, and its cost, counted in the work units it charges, stays well
// under the command's work limit on inputs that stalled jsdiff for
// seconds. The answers GNU gives are pinned by the recorded fixture.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "bun";
import { Bash, InMemoryFs } from "just-bash";
import { STEPS_PER_UNIT } from "../../../vendor/just-bash/src/commands/diff/diff.ts";
import {
  type CompareOptions,
  compare,
} from "../../../vendor/just-bash/src/commands/diff/engine.ts";
import { commandWorkLimit } from "../../../vendor/just-bash/src/limits.ts";

/** The default work limit, in units. */
const LIMIT = commandWorkLimit({});

function numbers(lines: string[]): Map<string, number> {
  const ids = new Map<string, number>();
  for (const line of lines) if (!ids.has(line)) ids.set(line, ids.size);
  return ids;
}

function run(
  a: string[],
  b: string[],
  options: Partial<CompareOptions> = {},
): { deleted: number; inserted: number; units: number; kept: string[] } {
  const ids = numbers([...a, ...b]);
  let steps = 0;
  const result = compare(
    Int32Array.from(a, (l) => ids.get(l) as number),
    Int32Array.from(b, (l) => ids.get(l) as number),
    ids.size,
    {
      giveUp: (LIMIT * STEPS_PER_UNIT) / 4,
      ...options,
      charge: (s) => {
        steps += s;
      },
    },
  );
  const keptA = a.filter((_, i) => !result.deleted[i]);
  const keptB = b.filter((_, i) => !result.inserted[i]);
  expect(keptA).toEqual(keptB);
  return {
    deleted: result.deleted.reduce((s, x) => s + x, 0),
    inserted: result.inserted.reduce((s, x) => s + x, 0),
    units: Math.ceil(steps / STEPS_PER_UNIT),
    kept: keptA,
  };
}

/** The longest common subsequence's length, by dynamic programming. */
function lcs(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
      diag = up;
    }
  }
  return row[b.length];
}

function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s;
  };
}

const numbered = (n: number, f: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => f(i));

const rfc = (name: string) =>
  new TextDecoder()
    .decode(
      gunzipSync(
        new Uint8Array(
          readFileSync(
            new URL(`../../fixtures/just-bash/${name}`, import.meta.url),
          ),
        ),
      ),
    )
    .split("\n");

describe("diff's compare", () => {
  test("finds a smallest answer on small inputs", () => {
    const next = random(42);
    for (let round = 0; round < 400; round++) {
      const a = numbered(next() % 14, () => "abcd"[next() % 4]);
      const b = numbered(next() % 14, () => "abcd"[next() % 4]);
      const best = lcs(a, b);
      for (const minimal of [false, true]) {
        const got = run(a, b, { minimal });
        expect(got.kept.length).toBe(best);
        expect(got.deleted).toBe(a.length - best);
        expect(got.inserted).toBe(b.length - best);
      }
    }
  });

  test("keeps the common head and tail within the horizon", () => {
    const a = numbered(20, (i) => `l${i}`);
    const b = [...a];
    b[10] = "x";
    expect(run(a, b, { horizon: 3 })).toMatchObject({
      deleted: 1,
      inserted: 1,
    });
  });

  test("slides an insertion to the end of equal lines", () => {
    const a = ["a", "b", "a", "b"];
    const b = ["a", "b", "a", "b", "a", "b"];
    const ids = numbers([...a, ...b]);
    const result = compare(
      Int32Array.from(a, (l) => ids.get(l) as number),
      Int32Array.from(b, (l) => ids.get(l) as number),
      ids.size,
      { charge: () => {} },
    );
    expect([...result.inserted]).toEqual([0, 0, 0, 0, 1, 1]);
  });

  test("slides a group to line up with a change in the other file", () => {
    // GNU diff answers 1,2d0 3a2 5c4 for these
    const a = ["b", "b", "c", "a", "a"];
    const b = ["c", "b", "a", "b"];
    const ids = numbers([...a, ...b]);
    const result = compare(
      Int32Array.from(a, (l) => ids.get(l) as number),
      Int32Array.from(b, (l) => ids.get(l) as number),
      ids.size,
      { charge: () => {} },
    );
    expect([...result.deleted]).toEqual([1, 1, 0, 0, 1]);
    expect([...result.inserted]).toEqual([0, 1, 0, 1]);
  });
});

describe("diff's cost", () => {
  // each well under a tenth of the default limit of 1M units
  const tenth = LIMIT / 10;

  test("two 20k-line files with nothing in common", () => {
    const got = run(
      numbered(20000, (i) => `a ${i}`),
      numbered(20000, (i) => `b ${i}`),
    );
    expect(got.deleted).toBe(20000);
    expect(got.units).toBeLessThan(tenth);
  });

  test("an RFC and its rewrite", () => {
    const got = run(rfc("diff-rfc7231.txt.gz"), rfc("diff-rfc9110.txt.gz"));
    expect(got.deleted).toBeGreaterThan(3000);
    expect(got.units).toBeLessThan(tenth);
  });

  test("every other line of 10k changed", () => {
    const got = run(
      numbered(10000, (i) => `line ${i}`),
      numbered(10000, (i) => (i % 2 ? `changed ${i}` : `line ${i}`)),
    );
    expect(got.deleted).toBe(5000);
    expect(got.units).toBeLessThan(tenth);
  });

  test("100k lines with one change", () => {
    const a = numbered(100000, (i) => `line ${i}`);
    const b = [...a];
    b[50000] = "changed";
    const got = run(a, b);
    expect(got.deleted).toBe(1);
    expect(got.units).toBeLessThan(tenth);
  });

  test("one hard box leaves budget for the rest", () => {
    // GNU diff changes 72728 lines of these, and 12738 of the blank-heavy
    // pair; taking boxes whole would change every line
    const shifted = run(
      numbered(100000, (i) => `${i % 7}`),
      numbered(100000, (i) => `${(i + 3) % 11}`),
    );
    expect(shifted.deleted + shifted.inserted).toBe(72728);
    expect(shifted.units).toBeLessThan(LIMIT / 4);
    const next = random(7);
    const blanks = () =>
      numbered(20000, (i) => (i % 3 ? "" : `l${(next() >> 8) % 50}`));
    const sparse = run(blanks(), blanks());
    expect(sparse.deleted + sparse.inserted).toBeLessThan(12800);
    expect(sparse.units).toBeLessThan(LIMIT / 4);
  });

  test("a default compare gives up looking before the limit", () => {
    const next = random(7);
    const a = numbered(20000, (i) => `x ${i}`);
    const b = [...a];
    for (let i = b.length - 1; i > 0; i--) {
      const j = next() % (i + 1);
      [b[i], b[j]] = [b[j], b[i]];
    }
    const got = run(a, b);
    expect(got.units).toBeLessThan(LIMIT / 2);
  });
});

describe("diff's work limit", () => {
  test("-d past the limit fails with its error and exit 2", async () => {
    const next = random(7);
    const lines = numbered(20000, (i) => `x ${i}\n`);
    const shuffled = [...lines];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = next() % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const fs = new InMemoryFs({}, {});
    fs.writeFileSync("/w/a", lines.join(""));
    fs.writeFileSync("/w/b", shuffled.join(""));
    const bash = new Bash({ fs, cwd: "/w" });
    const minimal = await bash.exec("diff -d a b; echo $?");
    expect(minimal.stdout).toBe("2\n");
    expect(minimal.stderr).toContain("work limit exceeded");
    const plain = await bash.exec("diff a b > /dev/null; echo $?");
    expect(plain.stdout).toBe("1\n");
  });
});
