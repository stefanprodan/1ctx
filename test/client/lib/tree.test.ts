// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  baseName,
  foldersOf,
  type TreeFolder,
  treeOf,
} from "../../../src/client/lib/tree.ts";

type Item = { name: string };

// a folder as a nested outline, for comparing whole trees
const outline = (folder: TreeFolder<Item>): unknown => ({
  path: folder.path,
  name: folder.name,
  count: folder.count,
  folders: folder.folders.map(outline),
  items: folder.items.map((item) => item.name),
});

test("names lay into folders, folders first, each level in name order", () => {
  const tree = treeOf<Item>([
    { name: "plans/b.md" },
    { name: "readme.md" },
    { name: "plans/a/b.md" },
    { name: "plans/a/a.md" },
    { name: "apps/podinfo.yaml" },
    { name: "Notes.md" },
  ]);
  expect(outline(tree)).toEqual({
    path: "",
    name: "",
    count: 6,
    folders: [
      {
        path: "apps",
        name: "apps",
        count: 1,
        folders: [],
        items: ["apps/podinfo.yaml"],
      },
      {
        path: "plans",
        name: "plans",
        count: 3,
        folders: [
          {
            path: "plans/a",
            name: "a",
            count: 2,
            folders: [],
            items: ["plans/a/a.md", "plans/a/b.md"],
          },
        ],
        items: ["plans/b.md"],
      },
    ],
    // a capital sorts with its letter, not before every lowercase one
    items: ["Notes.md", "readme.md"],
  });
});

test("the items keep what the caller gave them", () => {
  const file = { name: "a/b.md", id: "f1" };
  expect(treeOf([file]).folders[0]!.items[0]).toBe(file);
  expect(treeOf([]).count).toBe(0);
});

test("a name's base and the folders it sits in", () => {
  expect(baseName("plans/a/b.md")).toBe("b.md");
  expect(baseName("b.md")).toBe("b.md");
  expect(foldersOf("plans/a/b.md")).toEqual(["plans", "plans/a"]);
  expect(foldersOf("b.md")).toEqual([]);
});
