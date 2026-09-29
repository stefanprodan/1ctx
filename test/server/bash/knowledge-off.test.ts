// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  callCaps,
  run,
  type Setup,
  scratchState,
  seedScratch,
  setup,
} from "./helpers.ts";

const off = { ...callCaps, knowledge: false };
const discarded =
  "changes under /knowledge were discarded: the project docs are off\n";

const versions = (s: Setup) =>
  s.db
    .query<{ n: number }, []>("select count(*) as n from knowledge_versions")
    .get()!.n;

describe("a command with the project docs off", () => {
  test("mounts no /knowledge and starts in /tmp without a notice", async () => {
    const s = setup();
    try {
      s.knowledge.create(s.projectId, s.author, "docs/x.md", "secret\n");
      const result = await run(s, "pwd; ls /; cat /knowledge/docs/x.md", off);
      expect(result.content).toStartWith("/tmp\n");
      expect(result.content.split("\n")).not.toContain("knowledge");
      expect(result.content).toContain(
        "cat: /knowledge/docs/x.md: No such file",
      );
      expect(result.content).not.toContain("secret");
      expect(result.error).toBe(true);
      // a new chat still starts in the docs once they are on
      expect(scratchState(s).cwd).toBe("/knowledge");
    } finally {
      s.db.close();
    }
  });

  test("discards a write under /knowledge with the notice first and writes no version", async () => {
    const s = setup();
    try {
      const file = s.knowledge.create(
        s.projectId,
        s.author,
        "docs/x.md",
        "old\n",
      );
      const before = versions(s);
      const result = await run(
        s,
        "mkdir -p /knowledge/docs; echo new > /knowledge/docs/x.md; echo more > /knowledge/y.md; rm -rf /uploads; echo kept > /tmp/a.txt",
        off,
      );
      expect(result.content).toStartWith(
        `${discarded}changes under /uploads were discarded`,
      );
      expect(result.content).not.toContain("wrote");
      expect(result.error).toBe(false);
      expect(versions(s)).toBe(before);
      expect(s.knowledge.list(s.projectId).files.map((f) => f.name)).toEqual([
        "docs/x.md",
      ]);
      expect(s.knowledge.read(s.projectId, file.id)).toMatchObject({
        text: "old\n",
        revision: 1,
      });
      expect(scratchState(s).entries.map((entry) => entry.path)).toEqual([
        "a.txt",
      ]);
      // on again, the base is as it was
      const on = await run(s, "cat /knowledge/docs/x.md; ls /knowledge");
      expect(on.content).toStartWith("old\ndocs\n");
    } finally {
      s.db.close();
    }
  });

  test("a read-only command writes no version and says nothing", async () => {
    const s = setup();
    try {
      s.knowledge.create(s.projectId, s.author, "a.md", "a\n");
      s.knowledge.create(s.projectId, s.author, "b.md", "b\n");
      const before = versions(s);
      const result = await run(s, "echo hi", off);
      expect(result.content).toBe("hi\n\nexit 0");
      expect(versions(s)).toBe(before);
      expect(s.knowledge.list(s.projectId).files).toHaveLength(2);
    } finally {
      s.db.close();
    }
  });

  test("a saved cwd under /knowledge starts in /tmp and is kept for when the docs are on", async () => {
    const s = setup();
    try {
      s.knowledge.create(s.projectId, s.author, "docs/x.md", "x\n");
      expect((await run(s, "cd docs")).error).toBe(false);
      expect(scratchState(s).cwd).toBe("/knowledge/docs");
      expect((await run(s, "pwd", off)).content).toBe("/tmp\n\nexit 0");
      expect(scratchState(s).cwd).toBe("/knowledge/docs");
      const made = await run(
        s,
        "mkdir -p /knowledge/new; echo y > /knowledge/new/y.md; cd /knowledge/new",
        off,
      );
      expect(made.content).toStartWith(discarded);
      expect(scratchState(s).cwd).toBe("/knowledge/docs");
      expect((await run(s, "pwd")).content).toBe("/knowledge/docs\n\nexit 0");
    } finally {
      s.db.close();
    }
  });

  test("a command that moves elsewhere while the docs are off keeps its cwd", async () => {
    const s = setup();
    try {
      s.knowledge.create(s.projectId, s.author, "docs/x.md", "x\n");
      await run(s, "cd docs");
      await run(
        s,
        "mkdir /tmp/work; echo w > /tmp/work/w.txt; cd /tmp/work",
        off,
      );
      expect(scratchState(s).cwd).toBe("/tmp/work");
      expect((await run(s, "pwd")).content).toBe("/tmp/work\n\nexit 0");
    } finally {
      s.db.close();
    }
  });

  test("an empty folder under /knowledge is dropped without a notice", async () => {
    const s = setup();
    try {
      const result = await run(s, "mkdir -p /knowledge/a/b; echo hi", off);
      expect(result.content).toBe("hi\n\nexit 0");
    } finally {
      s.db.close();
    }
  });

  test("a missing cwd elsewhere starts in /tmp with the notice", async () => {
    const s = setup();
    try {
      seedScratch(s, { cwd: "/tmp/gone" });
      expect((await run(s, "pwd", off)).content).toBe(
        "started in /tmp: /tmp/gone no longer exists\n/tmp\n\nexit 0",
      );
    } finally {
      s.db.close();
    }
  });

  test("open finds nothing under /knowledge, even a file the command made", async () => {
    const s = setup();
    try {
      s.knowledge.create(s.projectId, s.author, "x.md", "x\n");
      const result = await run(
        s,
        "open /knowledge/x.md; mkdir /knowledge; echo y > /knowledge/y.md; open /knowledge/y.md",
        off,
      );
      expect(result.content).toContain("open: /knowledge/x.md: no such file");
      expect(result.content).toContain("open: /knowledge/y.md: no such file");
      expect(result.opened).toEqual([]);
    } finally {
      s.db.close();
    }
  });
});
