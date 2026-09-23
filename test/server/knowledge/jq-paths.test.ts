// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// jq assignments, del and path() through the vendored engine, against
// what jq 1.8 prints for the same input; null expects an error.

import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";

type Case = [input: unknown, filter: string, outputs: unknown[] | null];

const CASES: Case[] = [
  [
    { kind: "Service", spec: {} },
    'select(.kind == "Deployment").spec.replicas = 3',
    [{ kind: "Service", spec: {} }],
  ],
  [
    { kind: "Deployment", spec: { replicas: 1 } },
    'select(.kind == "Deployment").spec.replicas = 3',
    [{ kind: "Deployment", spec: { replicas: 3 } }],
  ],
  [
    [
      { n: "x", v: 1 },
      { n: "y", v: 2 },
    ],
    '(.[] | select(.n == "y") | .v) = 9',
    [
      [
        { n: "x", v: 1 },
        { n: "y", v: 9 },
      ],
    ],
  ],
  [{ a: { b: 1 } }, "(.a | .b) = 5", [{ a: { b: 5 } }]],
  [{ a: 1 }, "(.a, .b) = 7", [{ a: 7, b: 7 }]],
  [{ a: null, b: 1 }, "(.a // .b) = 5", [{ a: null, b: 5 }]],
  [{ a: 1 }, "(if .a then .x else .y end) = 1", [{ a: 1, x: 1 }]],
  [
    { a: { b: { c: 1 } }, d: 2 },
    "(.. | numbers) |= . + 1",
    [{ a: { b: { c: 2 } }, d: 3 }],
  ],
  [{ a: [1, 2, 3] }, ".a[] |= select(. != 2)", [{ a: [1, 3] }]],
  [{ a: [1, 2, 3, 4] }, "(.a[] | select(. >= 2)) |= empty", [{ a: [1] }]],
  [{ a: [3, 1, 2] }, "del(.a[] | select(. == 1))", [{ a: [3, 2] }]],
  [[1, 2, 3], "del(.[0,2])", [[2]]],
  [[1, 2, 3], '.[1:] = ["x"]', [[1, "x"]]],
  [[1, 2, 3], ".[-1] = 9", [[1, 2, 9]]],
  [{ a: 1 }, ".a = (1,2)", [{ a: 1 }, { a: 2 }]],
  [{ a: 1 }, ".a += (1,2)", [{ a: 2 }, { a: 3 }]],
  [{ a: 1 }, ".a |= (. + 1, . + 2)", [{ a: 2 }]],
  [{ a: [1, null] }, ".a[] //= 5", [{ a: [1, 5] }]],
  [{ c: {} }, ".a.b.c = 1", [{ c: {}, a: { b: { c: 1 } } }]],
  [{}, ".x[2].y = 1", [{ x: [null, null, { y: 1 }] }]],
  [
    [
      { n: "x", v: 1 },
      { n: "y", v: 2 },
    ],
    '[path(.[] | select(.n == "y") | .v)]',
    [[[1, "v"]]],
  ],
  [{ a: [1, 2] }, "[path(..)]", [[[], ["a"], ["a", 0], ["a", 1]]]],
  [{ a: 1, b: { c: 2 } }, "pick(.b.c)", [{ b: { c: 2 } }]],
  [{ a: 1 }, "def f: .a; f = 3", [{ a: 3 }]],
  [{ a: 1 }, "def g(x): x; g(.a) = 3", [{ a: 3 }]],
  [{ a: [1, 2, 3] }, "(.a | first) = 0", [{ a: [0, 2, 3] }]],
  [{ a: [1, 2, 3] }, "(limit(2; .a[])) = 0", [{ a: [0, 0, 3] }]],
  [{ a: 1 }, '(.a | tostring) = "1"', null],
  [{ a: 1 }, ".a.b = 1", null],
  [[1], ".a = 1", null],
  // null iterates to nothing here, as in mikefarah's yq; jq stops on it
  [null, ".[] = 1", [null]],
  [[1, 2, 3], ".[-5] = 9", null],
  [
    {
      spec: {
        template: {
          spec: {
            containers: [
              { name: "app", image: "a:1" },
              { name: "side", image: "s:1" },
            ],
          },
        },
      },
    },
    '(.spec.template.spec.containers[] | select(.name == "app") | .image) = "a:2"',
    [
      {
        spec: {
          template: {
            spec: {
              containers: [
                { name: "app", image: "a:2" },
                { name: "side", image: "s:1" },
              ],
            },
          },
        },
      },
    ],
  ],
  [
    { metadata: { labels: { app: "web" } } },
    '.metadata.labels += {"team":"platform"}',
    [{ metadata: { labels: { app: "web", team: "platform" } } }],
  ],
  // deletions of one level go together, against it as it was
  [[1, 2, 3, 4, 5], "del(.[-1], .[-2])", [[1, 2, 3]]],
  [[1, 2, 3, 4, 5], "del(.[1:3], .[2])", [[1, 4, 5]]],
  [[1, 2, 3, 4, 5], "del(.[1:3], .[0:2])", [[4, 5]]],
  [[1, 2, 3, 4, 5], "(.[0], .[0]) |= empty", [[2, 3, 4, 5]]],
  [[1, 2, 3, 4, 5], "del(.[-7], .[0])", [[2, 3, 4, 5]]],
  [[1, [2, 3]], "delpaths([[0], [0, 1]])", [[[2, 3]]]],
  [{ a: { d: [1, 2, 3] } }, "del(.a.d[:2], .a.d[1:])", [{ a: { d: [] } }]],
  // what came before an error or a break is kept
  [
    [1, 2, 3, 4, 5],
    "(label $f | (.[0] | ., break $f), .[1]) = 9",
    [[9, 2, 3, 4, 5]],
  ],
  [[1, 2, 3], "(label $f | (.[0], break $f, .[1])?) = 9", [[9, 2, 3]]],
  [
    [{ spec: { replicas: 1 } }, { spec: "x" }, { spec: { replicas: 1 } }],
    "(.[].spec.replicas)? = 3",
    [[{ spec: { replicas: 3 } }, { spec: "x" }, { spec: { replicas: 1 } }]],
  ],
  [
    [1, 2, 3, 4, 5],
    "(try (.[0], .[1][0], .[2]) catch empty) = 9",
    [[9, 2, 3, 4, 5]],
  ],
  // $x parameters are bound, in value and in path mode
  [null, "def f($x): [$x, x]; f(3)", [[3, 3]]],
  [null, "[def f($x): $x; f(1, 2)]", [[1, 2]]],
  [
    { spec: { r: 1 } },
    'def f($x): .spec[$x]; f("r") = 42',
    [{ spec: { r: 42 } }],
  ],
];

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

  test("an update over a large array stays linear", async () => {
    const fs = new InMemoryFs();
    const items = Array.from({ length: 20_000 }, (_, i) => ({ i }));
    await fs.writeFile("/in.json", JSON.stringify(items));
    const started = performance.now();
    const result = await new Bash({ fs }).exec(
      "jq '.[] |= (.i += 1) | length' /in.json",
    );
    expect(result.stdout).toBe("20000\n");
    expect(performance.now() - started).toBeLessThan(2_000);
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
