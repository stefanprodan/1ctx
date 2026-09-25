// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Named items laid into folders by the slashes in their names, for
// RowsTree: each folder's folders first, then its items, both in name
// order, and the count of items under each folder at any depth.

// a folder lists this many items before it ends in Show more
export const FOLDER_ROWS = 50;

export type TreeFolder<T> = {
  // the folder's path from the root, "" for the root itself
  path: string;
  name: string;
  folders: TreeFolder<T>[];
  items: T[];
  count: number;
};

export function treeOf<T extends { name: string }>(
  items: readonly T[],
): TreeFolder<T> {
  const root: TreeFolder<T> = {
    path: "",
    name: "",
    folders: [],
    items: [],
    count: 0,
  };
  const folders = new Map<string, TreeFolder<T>>([["", root]]);
  for (const item of items) {
    const parts = item.name.split("/");
    let folder = root;
    folder.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = folders.get(path);
      if (next === undefined) {
        next = { path, name: parts[i]!, folders: [], items: [], count: 0 };
        folders.set(path, next);
        folder.folders.push(next);
      }
      next.count++;
      folder = next;
    }
    folder.items.push(item);
  }
  for (const folder of folders.values()) {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.items.sort((a, b) => a.name.localeCompare(b.name));
  }
  return root;
}

// an item's name inside its folder
export function baseName(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

// the folders a name sits in, outermost first: "a/b/c.md" is "a", "a/b"
export function foldersOf(name: string): string[] {
  const parts = name.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}
