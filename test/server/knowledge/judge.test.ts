// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  judgeMembers,
  selectMembers,
  selectUploadMembers,
  skippedName,
} from "../../../src/server/knowledge/judge.ts";
import type { ArchiveMember } from "../../../src/server/lib/archive.ts";
import type { KnowledgeUploadReason } from "../../../src/shared/contracts/knowledge.ts";

const entry = (
  name: string,
  text: string | Uint8Array = "text",
  type: ArchiveMember["type"] = "file",
): Omit<ArchiveMember, "index"> => {
  const data = typeof text === "string" ? new TextEncoder().encode(text) : text;
  return { name, type, data, size: data.length };
};

const live = new Map([
  ["live", { bytes: 4, text: "text" }],
  ["same", { bytes: 4, text: "text" }],
  ["replace", { bytes: 8, text: "old text" }],
]);

function judge(
  entries: Omit<ArchiveMember, "index">[],
  folder = "",
  fileBytes = 6,
) {
  const manifest = entries.map((file, index) => ({ ...file, index }));
  return judgeMembers(
    manifest,
    selectMembers(manifest, folder),
    live,
    fileBytes,
  );
}

function permutations<T>(items: T[]): T[][] {
  if (items.length === 0) return [[]];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, i) => i !== index)).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

const cases: {
  reason: KnowledgeUploadReason;
  entries: Omit<ArchiveMember, "index">[];
}[] = [
  { reason: "not-regular", entries: [entry("link", "", "symlink")] },
  { reason: "outside", entries: [entry("docs/../x")] },
  { reason: "no-letters", entries: [entry("\u65e5\u672c\u8a9e")] },
  { reason: "too-long", entries: [entry("x".repeat(81))] },
  { reason: "bad-name", entries: [entry(".-.")] },
  { reason: "duplicate", entries: [entry("A b.md"), entry("a-b.md")] },
  { reason: "too-big", entries: [entry("large", "1234567")] },
  { reason: "not-text", entries: [entry("binary", new Uint8Array([255]))] },
  { reason: "clash", entries: [entry("docs"), entry("docs/child")] },
  { reason: "clash-live", entries: [entry("live/child")] },
];

test.each(cases)(
  "$reason preserves eligible files in every order",
  ({ reason, entries }) => {
    const alone = judge(entries);
    expect(alone.files).toEqual([]);
    expect(alone.result.skipped.map((skip) => skip.reason)).toEqual(
      entries.map(() => reason),
    );
    for (const skip of alone.result.skipped) {
      if (reason === "duplicate" || reason === "clash") {
        expect(skip.other).toBe(1 - skip.index);
      } else {
        expect(skip).not.toHaveProperty("other");
      }
    }
    for (const order of permutations([
      ...entries,
      entry("a", "\0"),
      entry("a/b"),
    ])) {
      const { files, result } = judge(order);
      expect(files).toEqual([{ name: "a/b", text: "text", replaces: false }]);
      expect(result.saved).toEqual(["a/b"]);
      expect(result).toMatchObject({
        skippedTotal: entries.length + 1,
        renamed: 0,
      });
      expect(
        result.skipped
          .map((skip) => [order[skip.index]!.name, skip.reason])
          .sort(),
      ).toEqual(
        [
          ...entries.map((file) => [file.name, reason]),
          ["a", "not-text"],
        ].sort(),
      );
      for (const skip of result.skipped) {
        if (skip.reason === "duplicate" || skip.reason === "clash") {
          // the pair names each other whatever the order
          expect(order[skip.other!]!.name).toBe(
            entries.find((file) => file.name !== order[skip.index]!.name)!.name,
          );
        } else {
          expect(skip).not.toHaveProperty("other");
        }
      }
    }
  },
);

test("the judged result has no knowledge identities and keeps saved order", () => {
  expect(
    judge([
      entry("New Name.md"),
      entry("Same"),
      entry("replace", "new"),
      entry("empty", ""),
    ]),
  ).toEqual({
    files: [
      { name: "new-name.md", text: "text", replaces: false },
      { name: "replace", text: "new", replaces: true },
      { name: "empty", text: "", replaces: false },
    ],
    result: {
      added: 2,
      replaced: 1,
      unchanged: 1,
      renamed: 1,
      saved: ["new-name.md", "replace", "empty"],
      skipped: [],
      skippedTotal: 0,
    },
  });
});

test("manifest selection excludes duplicates, metadata and invalid names before bytes", () => {
  const names = [
    "A b.md",
    "a-b.md",
    "A-B.MD",
    "../outside",
    "__MACOSX/link",
    ".git/config",
    "nested/.hg/store",
    ".svn/entries",
    ".DS_Store",
    "nested/._file",
    ".gitignore",
  ];
  const manifest: ArchiveMember[] = names.map((name, index) => ({
    name,
    index,
    size: 4,
    type: "file",
  }));
  const selection = selectMembers(manifest, "");
  expect(selection.candidates.map((file) => file.index)).toEqual([10]);
  expect(
    selection.skipped.map(({ index, reason, other }) => ({
      index,
      reason,
      other,
    })),
  ).toEqual([
    { index: 3, reason: "outside", other: undefined },
    { index: 0, reason: "duplicate", other: 1 },
    { index: 1, reason: "duplicate", other: 0 },
    { index: 2, reason: "duplicate", other: 0 },
  ]);
  expect(() => judgeMembers(manifest, selection, live, 6)).toThrow(
    "an upload member was not read",
  );
  manifest[10]!.data = new TextEncoder().encode("text");
  expect(judgeMembers(manifest, selection, live, 6).result.saved).toEqual([
    ".gitignore",
  ]);
});

test.each([
  {
    label: "one normalized root despite ignored and rejected names",
    entries: [
      entry("unused", "", "directory"),
      entry("link", "", "symlink"),
      entry("__MACOSX/file"),
      entry(".git/HEAD"),
      entry(".hg/store"),
      entry(".svn/entries"),
      entry(".DS_Store"),
      entry("._file"),
      entry("../outside"),
      entry("A b.md"),
      entry("a-b.md"),
      entry("./Run Books//one.md"),
      entry("run-books\\two.md"),
    ],
    folder: "",
    names: ["run-books/one.md", "run-books/two.md"],
  },
  {
    label: "a regular root dotfile",
    entries: [entry(".gitignore"), entry("docs/one.md")],
    folder: "picked",
    names: ["picked/.gitignore", "picked/docs/one.md"],
  },
  {
    label: "no kept members",
    entries: [entry("docs", "", "directory"), entry(".git/HEAD")],
    folder: "picked",
    names: [],
  },
  {
    label: "a single-root path already at its segment cap",
    entries: [entry("a/b/c/d/e/f/g/h")],
    folder: "",
    names: ["a/b/c/d/e/f/g/h"],
  },
  {
    label: "an added folder still counts toward the segment cap",
    entries: [entry("a/b/c/d/e/f/g/h"), entry("root.md")],
    folder: "picked",
    names: ["picked/root.md"],
  },
])("archive folder selection depends only on names: $label", (fixture) => {
  const manifest = fixture.entries.map(({ data: _, ...file }, index) => ({
    ...file,
    index,
  }));
  const selection = selectUploadMembers(manifest, "Picked.tar.gz");
  expect(selection.folder).toBe(fixture.folder);
  expect(selection.candidates.map((file) => file.name)).toEqual([
    ...fixture.names,
  ]);
});

test("directories disappear, non-regular types skip, and folders count toward path caps", () => {
  const { result } = judge(
    [
      entry("docs", "", "directory"),
      entry("hardlink", "", "link"),
      entry("device", "", "other"),
      entry("./plain//name"),
    ],
    "folder",
  );
  expect(result.saved).toEqual(["folder/plain/name"]);
  expect(result.renamed).toBe(0);
  expect(result.skipped.map((skip) => skip.reason)).toEqual([
    "not-regular",
    "not-regular",
  ]);
  expect(judge([entry("h/i")], "a/b/c/d/e/f/g").result.skipped).toMatchObject([
    { reason: "too-long" },
  ]);
});

test("directories and macOS metadata vanish, every other non-regular type skips", () => {
  const { result } = judge([
    entry("ignored/", "", "directory"),
    entry("__MACOSX/symlink", "", "symlink"),
    entry("hardlink", "", "link"),
    entry("device", "", "other"),
    entry("./__MACOSX/x"),
    entry("a\\._b"),
    entry("a/.DS_Store"),
    entry("a/./__MACOSX//x"),
    entry("__macosx", ""),
  ]);
  // metadata is judged on the raw name, before normalization, so a
  // lowercase __macosx is an ordinary file
  expect(result.skipped.map(({ index, reason }) => [index, reason])).toEqual([
    [2, "not-regular"],
    [3, "not-regular"],
  ]);
  expect(result.skippedTotal).toBe(2);
  expect(result.saved).toEqual(["__macosx"]);
});

test("every eligible ancestor loses while a rejected ancestor blocks nothing", () => {
  for (const entries of permutations([
    entry("a"),
    entry("a/b"),
    entry("a/b/c"),
  ])) {
    const { files, result } = judge(entries);
    expect(files).toEqual([]);
    expect(result.skipped.map((skip) => skip.reason)).toEqual([
      "clash",
      "clash",
      "clash",
    ]);
    for (const skip of result.skipped) {
      expect(skip.other).toBe(skip.index === 0 ? 1 : 0);
    }
  }
  expect(judge([entry("a", "too large"), entry("a/b")]).result.saved).toEqual([
    "a/b",
  ]);
  const manifest = [entry("folder")].map((file, index) => ({ ...file, index }));
  expect(
    judgeMembers(
      manifest,
      selectMembers(manifest, ""),
      new Map([["folder/child", { text: "text", bytes: 4 }]]),
      6,
    ).result.skipped,
  ).toMatchObject([{ reason: "clash-live" }]);
});

test("lowered file caps permit only smaller replacements and UTF-8 stays text", () => {
  expect(judge([entry("replace", "1234567")]).files).toEqual([
    { name: "replace", text: "1234567", replaces: true },
  ]);
  expect(judge([entry("replace", "12345678")]).result.skipped).toMatchObject([
    { reason: "too-big" },
  ]);
  expect(
    judge([entry("bom", "\ufeffok"), entry("replacement", "\ufffd")]).files,
  ).toEqual([
    { name: "bom", text: "ok", replaces: false },
    { name: "replacement", text: "\ufffd", replaces: false },
  ]);
});

test.each(["\u0001", "\u200b", "\ud800"])(
  "display names and both outcome lists are bounded: %j",
  (character) => {
    const display = skippedName(character.repeat(500));
    expect(display.length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(JSON.stringify(display))).toBeLessThanOrEqual(300);
    // long saved names first, so the cut list holds the longest
    const entries = [
      ...Array.from({ length: 200 }, (_, i) =>
        entry(
          `${"a".repeat(80)}/${"b".repeat(80)}/${`${i}`.padStart(38, "c")}`,
        ),
      ),
      ...Array.from({ length: 201 }, (_, i) => entry(`file${i}`)),
      ...Array.from({ length: 1800 }, (_, i) =>
        entry(`${character.repeat(200)}${"!".repeat(i + 1)}a.md`),
      ),
    ];
    const { files, result } = judge(entries);
    expect(files).toHaveLength(401);
    expect(result).toMatchObject({ added: 401, skippedTotal: 1800 });
    expect(result.saved).toHaveLength(200);
    expect(result.skipped).toHaveLength(200);
    expect(
      result.skipped.every(
        (skip) => skip.reason === "duplicate" && skip.name.length <= 200,
      ),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(128 * 1024);
  },
);
