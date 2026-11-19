// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The read-back rules over the tree fixtures, once over the listing as
// given and once over just-bash's listing of the same tree, so the
// builtin shell and the rules cannot drift.

import { describe, expect, test } from "bun:test";
import { InMemoryFs } from "just-bash";
import {
  discardNotices,
  normalizePath,
  readBack,
  savedCwd,
  startNotice,
  type TreeEntry,
} from "../../../src/server/bash/index.ts";
import type { Job } from "../../../src/server/bash/protocol.ts";
import { isDirectoryIn, listTree } from "../../../src/server/bash/tree.ts";
import {
  type CaseEntry,
  TREE_CASES,
  type TreeCase,
} from "../../fixtures/bash/tree-cases.ts";

const encode = (text: string) => new TextEncoder().encode(text);

const asEntry = ({ target: _, text, ...entry }: CaseEntry): TreeEntry =>
  text === undefined ? entry : { ...entry, bytes: encode(text) };

async function judged(
  item: TreeCase,
  entries: TreeEntry[],
  isDirectory: (path: string) => boolean | Promise<boolean>,
) {
  const start = await savedCwd(item.mount.cwd, item.mount.docs, isDirectory);
  return {
    notice: discardNotices(entries, item.mount),
    readBack: await readBack(entries, item.mount, {
      exitCode: item.exitCode ?? 0,
      start,
      pwd: item.pwd ?? item.mount.cwd,
      isDirectory,
    }),
  };
}

function check(item: TreeCase, got: Awaited<ReturnType<typeof judged>>): void {
  expect(got.notice).toBe(item.notice);
  if ("refusedContains" in item.expected) {
    expect(got.readBack.changes).toBeNull();
    expect(got.readBack.refused).toContain(item.expected.refusedContains);
  } else {
    expect(got.readBack).toEqual(item.expected);
  }
}

// the case's tree in just-bash's filesystem, as a command would leave it
async function materialize(tree: readonly CaseEntry[]): Promise<InMemoryFs> {
  const fs = new InMemoryFs();
  for (const root of ["/knowledge", "/tmp", "/uploads", "/mcp", "/repos"])
    if (await fs.exists(root)) await fs.rm(root, { recursive: true });
  const sorted = [...tree].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  for (const entry of sorted) {
    if (entry.kind === "dir") fs.mkdirSync(entry.path, { recursive: true });
    else if (entry.kind === "file")
      fs.writeFileSync(entry.path, encode(entry.text ?? ""), undefined, {
        mode: entry.mode,
      });
    else if (entry.kind === "link")
      await fs.symlink(entry.target ?? "/", entry.path);
  }
  return fs;
}

describe("the read-back rules over a listing", () => {
  for (const item of TREE_CASES) {
    test(item.name, async () => {
      const entries = item.tree.map(asEntry);
      const dirs = new Set(
        entries.filter((entry) => entry.kind === "dir").map((e) => e.path),
      );
      check(item, await judged(item, entries, (path) => dirs.has(path)));
    });
  }

  test("a listing in any order reads the same", async () => {
    for (const item of TREE_CASES) {
      const entries = item.tree.map(asEntry);
      const dirs = new Set(
        entries.filter((entry) => entry.kind === "dir").map((e) => e.path),
      );
      const forward = await judged(item, entries, (path) => dirs.has(path));
      const backward = await judged(item, [...entries].reverse(), (path) =>
        dirs.has(path),
      );
      expect(backward).toEqual(forward);
    }
  });
});

describe("just-bash's listing of the same trees", () => {
  for (const item of TREE_CASES.filter((each) => !each.realOnly)) {
    test(item.name, async () => {
      const fs = await materialize(item.tree);
      const job = { ...item.mount, repos: [] } as unknown as Job;
      const entries = await listTree(fs, job);
      check(
        item,
        await judged(item, entries, (path) => isDirectoryIn(fs, path)),
      );
    });
  }
});

describe("the cwd rules", () => {
  test("a path normalizes as just-bash resolves it", () => {
    for (const [path, want] of [
      ["/", "/"],
      ["", "/"],
      ["//", "/"],
      ["/tmp/", "/tmp"],
      ["/tmp/./a/../b", "/tmp/b"],
      ["/../tmp", "/tmp"],
      ["/tmp//a", "/tmp/a"],
    ])
      expect(normalizePath(path!)).toBe(want!);
  });

  test("a start that moved says so, unless the docs are off", () => {
    expect(startNotice("/tmp/gone", "/knowledge", true)).toBe(
      "started in /knowledge: /tmp/gone no longer exists\n",
    );
    expect(startNotice("/tmp", "/tmp", true)).toBe("");
    expect(startNotice("/knowledge/x", "/tmp", false)).toBe("");
  });

  test("a relative or missing cwd goes home", async () => {
    const yes = () => true;
    expect(await savedCwd(undefined, true, yes)).toBe("/knowledge");
    expect(await savedCwd("tmp", false, yes)).toBe("/tmp");
    expect(await savedCwd("/etc", true, yes)).toBe("/knowledge");
    expect(await savedCwd("/knowledge/a", false, yes)).toBe("/tmp");
  });
});
