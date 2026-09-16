// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  type MemoryOperation,
  replay,
} from "../../../src/server/memory/index.ts";
import type { MemoryEntry } from "../../../src/shared/contracts/memory.ts";

const entry = (topic: string, text = "old"): MemoryEntry => ({ topic, text });
const set: MemoryOperation = {
  action: "set",
  topic: "Note",
  text: "run",
  expected: "old",
};
const remove: MemoryOperation = {
  action: "remove",
  topic: "Note",
  expected: "old",
};

const cases: {
  name: string;
  current: MemoryEntry[];
  operations: MemoryOperation[];
  entries: MemoryEntry[];
  skippedOperations: number[];
}[] = [
  {
    name: "a hand-edited topic skips a set",
    current: [entry("NOTE", "hand")],
    operations: [set],
    entries: [entry("NOTE", "hand")],
    skippedOperations: [0],
  },
  {
    name: "a new topic applies beside a hand edit",
    current: [entry("Other", "hand")],
    operations: [{ action: "set", topic: "Note", text: "run", expected: null }],
    entries: [entry("Other", "hand"), entry("Note", "run")],
    skippedOperations: [],
  },
  {
    name: "an existing result is a no-op with case-insensitive equality",
    current: [entry("NOTE", "run")],
    operations: [set],
    entries: [entry("NOTE", "run")],
    skippedOperations: [],
  },
  {
    name: "an already removed or undone topic is a no-op",
    current: [],
    operations: [remove],
    entries: [],
    skippedOperations: [],
  },
  {
    name: "a hand-edited topic skips a remove",
    current: [entry("Note", "hand")],
    operations: [remove],
    entries: [entry("Note", "hand")],
    skippedOperations: [0],
  },
  {
    name: "an undone or removed entry is never revived",
    current: [],
    operations: [set],
    entries: [],
    skippedOperations: [0],
  },
  {
    name: "a hand-renamed topic does not revive the old name",
    current: [entry("Renamed")],
    operations: [set],
    entries: [entry("Renamed")],
    skippedOperations: [0],
  },
  {
    name: "remove then set cannot revive an absent topic under another case",
    current: [entry("Other", "hand")],
    operations: [
      remove,
      { ...set, topic: "NOTE", expected: null },
      { action: "none" },
      { ...set, topic: "note", expected: "run", text: "later" },
      { ...remove, topic: "note", expected: "later" },
      { ...set, expected: null },
      { ...set, topic: "New", expected: null },
    ],
    entries: [entry("Other", "hand"), entry("New", "run")],
    skippedOperations: [1, 3, 5],
  },
  {
    name: "a first set expecting old text blocks a later set expecting absence",
    current: [],
    operations: [
      set,
      { ...remove, expected: "run" },
      { ...set, expected: null },
    ],
    entries: [],
    skippedOperations: [0, 2],
  },
  {
    name: "remove then set still works when the topic exists at replay start",
    current: [entry("NOTE")],
    operations: [remove, { ...set, expected: null }],
    entries: [entry("Note", "run")],
    skippedOperations: [],
  },
  {
    name: "a genuinely new topic can be removed and created again",
    current: [],
    operations: [
      { ...set, expected: null },
      { ...remove, expected: "run" },
      { ...set, expected: null },
    ],
    entries: [entry("Note", "run")],
    skippedOperations: [],
  },
  {
    name: "ordered operations see the preceding operation's result",
    current: [entry("NOTE"), entry("Other")],
    operations: [set, { ...remove, expected: "run" }, { action: "none" }],
    entries: [entry("Other")],
    skippedOperations: [],
  },
  {
    name: "a new topic created by hand does not lose its text",
    current: [entry("Note", "hand")],
    operations: [{ ...set, expected: null }],
    entries: [entry("Note", "hand")],
    skippedOperations: [0],
  },
  {
    name: "none is never skipped beside conflicts",
    current: [entry("Note", "hand")],
    operations: [set, { action: "none" }, remove],
    entries: [entry("Note", "hand")],
    skippedOperations: [0, 2],
  },
];

describe("memory expectation replay", () => {
  for (const fixture of cases) {
    test(fixture.name, () => {
      const before = JSON.stringify(fixture);
      for (let retry = 0; retry < 2; retry++) {
        expect(replay(fixture.current, fixture.operations)).toEqual({
          entries: fixture.entries,
          skipped: fixture.skippedOperations.length,
          skippedOperations: fixture.skippedOperations,
        });
        expect(JSON.stringify(fixture)).toBe(before);
      }
    });
  }

  test("skips budget and cap violations without changing the note", () => {
    const current = Array.from({ length: 4 }, (_, i) =>
      entry(`${i}`, "x".repeat(500)),
    );
    const operations: MemoryOperation[] = [
      { action: "set", topic: "New", text: "y".repeat(500), expected: null },
      {
        action: "set",
        topic: "Long text",
        text: "y".repeat(501),
        expected: null,
      },
      { action: "set", topic: "t".repeat(61), text: "value", expected: null },
      { action: "none" },
      { action: "set", topic: "Fits", text: "small", expected: null },
    ];
    expect(replay(current, operations)).toEqual({
      entries: [...current, entry("Fits", "small")],
      skipped: 3,
      skippedOperations: [0, 1, 2],
    });
  });
});
