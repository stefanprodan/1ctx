// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, spyOn, test } from "bun:test";
import {
  applyEdits,
  type KnowledgeEdit,
  MAX_EDITS,
} from "../../../src/server/knowledge/edit.ts";
import { BadRequest } from "../../../src/server/lib/errors.ts";

const PLAN = "# Plan\n\n- one\n- two\n- three\n";

const applied: [string, string, KnowledgeEdit[], string][] = [
  ["one pair", PLAN, [{ old: "- two", new: "- 2" }], PLAN.replace("two", "2")],
  [
    "pairs apply at their own places",
    PLAN,
    [
      { old: "- three", new: "- 3" },
      { old: "# Plan", new: "# Done" },
    ],
    "# Done\n\n- one\n- two\n- 3\n",
  ],
  [
    "an empty new deletes",
    PLAN,
    [{ old: "- one\n", new: "" }],
    "# Plan\n\n- two\n- three\n",
  ],
  [
    "adjacent matches touch without overlapping",
    "abcd",
    [
      { old: "ab", new: "AB" },
      { old: "cd", new: "CD" },
    ],
    "ABCD",
  ],
  [
    "a new holding another pair's old is never matched again",
    "a b",
    [
      { old: "a", new: "b b" },
      { old: " b", new: "!" },
    ],
    "b b!",
  ],
  ["new may equal old", "same", [{ old: "same", new: "same" }], "same"],
];

const refused: [string, string, KnowledgeEdit[], string][] = [
  ["no pairs", PLAN, [], "edits must hold 1 to 50 pairs"],
  [
    "an empty old",
    PLAN,
    [
      { old: "one", new: "1" },
      { old: "", new: "x" },
    ],
    "edit 2: old is empty",
  ],
  [
    "an old matching nowhere",
    PLAN,
    [
      { old: "one", new: "1" },
      { old: "four", new: "4" },
    ],
    "edit 2: no match",
  ],
  [
    "an old matching twice",
    "a b a",
    [
      { old: "b", new: "B" },
      { old: "a", new: "A" },
    ],
    "edit 2: matches more than once",
  ],
  [
    "counts every match",
    "x x x",
    [{ old: "x", new: "y" }],
    "edit 1: matches more than once",
  ],
  [
    "counts overlapping matches",
    "aaa",
    [{ old: "aa", new: "b" }],
    "edit 1: matches more than once",
  ],
  [
    "two pairs overlapping",
    "abcdef",
    [
      { old: "cde", new: "-" },
      { old: "abc", new: "+" },
    ],
    "edit 2: overlaps edit 1",
  ],
  [
    "one pair inside another",
    "abcdef",
    [
      { old: "abcdef", new: "-" },
      { old: "cd", new: "+" },
    ],
    "edit 2: overlaps edit 1",
  ],
  [
    "the same old twice",
    PLAN,
    [
      { old: "- one", new: "1" },
      { old: "- one", new: "2" },
    ],
    "edit 2: overlaps edit 1",
  ],
  [
    "an old found only in another pair's new",
    "a",
    [
      { old: "a", new: "b" },
      { old: "b", new: "c" },
    ],
    "edit 2: no match",
  ],
];

describe("knowledge edits", () => {
  for (const [name, text, edits, want] of applied) {
    test(`applies ${name}`, () => {
      expect(applyEdits(text, edits)).toBe(want);
    });
  }

  for (const [name, text, edits, words] of refused) {
    test(`refuses ${name}`, () => {
      expect(() => applyEdits(text, edits)).toThrow(new BadRequest(words));
    });
  }

  test("the order of the pairs never changes the text", () => {
    const edits: KnowledgeEdit[] = [
      { old: "# Plan", new: "# Done" },
      { old: "- one", new: "- 1" },
      { old: "three\n", new: "3\n- four\n" },
    ];
    const want = applyEdits(PLAN, edits);
    expect(want).toBe("# Done\n\n- 1\n- two\n- 3\n- four\n");
    expect(applyEdits(PLAN, [...edits].reverse())).toBe(want);
    expect(applyEdits(PLAN, [edits[1]!, edits[2]!, edits[0]!])).toBe(want);
  });

  test("takes at most MAX_EDITS pairs", () => {
    const text = Array.from({ length: MAX_EDITS + 1 }, (_, i) => `<${i}>`).join(
      "",
    );
    const edits = Array.from({ length: MAX_EDITS + 1 }, (_, i) => ({
      old: `<${i}>`,
      new: `[${i}]`,
    }));
    expect(applyEdits(text, edits.slice(0, MAX_EDITS))).toStartWith("[0][1]");
    expect(() => applyEdits(text, edits)).toThrow(
      new BadRequest("edits must hold 1 to 50 pairs"),
    );
  });

  // counting every overlapping match costs matches times old's length;
  // the spy patches String.prototype, so the test is serial
  test.serial("a long old on repetitive text stops at its second match", () => {
    const text = "a".repeat(256 * 1024);
    const old = "a".repeat(128 * 1024);
    const search = spyOn(String.prototype, "indexOf");
    try {
      expect(() => applyEdits(text, [{ old, new: "b" }])).toThrow(
        new BadRequest("edit 1: matches more than once"),
      );
      const searches = search.mock.calls.filter(([needle]) => needle === old);
      expect(searches.length).toBe(2);
    } finally {
      search.mockRestore();
    }
  });
});
