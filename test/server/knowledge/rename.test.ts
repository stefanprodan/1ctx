// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { parseRename } from "../../../src/server/knowledge/parse.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import {
  BadRequest,
  Conflict,
  NotFound,
} from "../../../src/server/lib/errors.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { afterMountRead, run, setup } from "../bash/helpers.ts";

describe("knowledge rename", () => {
  test("keeps the id and the text and writes one version", () => {
    const s = setup();
    try {
      const file = s.knowledge.create(
        s.projectId,
        s.author,
        "docs/a.md",
        "text\n",
      );
      s.now.value = 200;
      const renamed = s.knowledge.rename(
        s.projectId,
        s.agent,
        file.id,
        "notes/b.ts",
        1,
      );
      expect(renamed).toMatchObject({
        id: file.id,
        name: "notes/b.ts",
        kind: "ts",
        revision: 2,
        bytes: file.bytes,
        lines: file.lines,
        author: s.agent,
        createdAt: file.createdAt,
        updatedAt: 200,
      });
      expect(s.knowledge.read(s.projectId, file.id).text).toBe("text\n");
      expect(s.knowledge.store.byName(s.projectId, "docs/a.md")).toBeNull();
      const versions = s.knowledge.versions(s.projectId, file.id);
      expect(versions.map((v) => [v.revision, v.name])).toEqual([
        [2, "notes/b.ts"],
        [1, "docs/a.md"],
      ]);
      expect(s.knowledge.version(s.projectId, versions[0]!.id).text).toBe(
        "text\n",
      );
      expect(s.knowledge.list(s.projectId).deleted).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  test("refuses a stale revision with the replace's words", () => {
    const s = setup();
    try {
      const file = s.knowledge.create(s.projectId, s.author, "a.md", "one");
      s.knowledge.replace(s.projectId, s.author, file.id, "two", 1);
      expect(() =>
        s.knowledge.rename(s.projectId, s.author, file.id, "b.md", 1),
      ).toThrow(new Conflict("a.md is at revision 2"));
    } finally {
      s.db.close();
    }
  });

  test("refuses a taken name, a prefix clash and the same name", () => {
    const s = setup();
    try {
      const file = s.knowledge.create(s.projectId, s.author, "a.md", "one");
      s.knowledge.create(s.projectId, s.author, "b.md", "two");
      s.knowledge.create(s.projectId, s.author, "dir/c.md", "three");
      expect(() =>
        s.knowledge.rename(s.projectId, s.author, file.id, "b.md", 1),
      ).toThrow(new Conflict("a file named b.md exists"));
      expect(() =>
        s.knowledge.rename(s.projectId, s.author, file.id, "dir", 1),
      ).toThrow(new Conflict("dir/c.md conflicts with file dir"));
      expect(() =>
        s.knowledge.rename(s.projectId, s.author, file.id, "b.md/x", 1),
      ).toThrow(new Conflict("b.md/x conflicts with file b.md"));
      expect(() =>
        s.knowledge.rename(s.projectId, s.author, file.id, "a.md", 1),
      ).toThrow(new BadRequest("the file is named a.md already"));
      expect(s.knowledge.read(s.projectId, file.id).revision).toBe(1);
    } finally {
      s.db.close();
    }
  });

  test("a file may move under its own old name", () => {
    const s = setup();
    try {
      const file = s.knowledge.create(s.projectId, s.author, "a", "one");
      const moved = s.knowledge.rename(
        s.projectId,
        s.author,
        file.id,
        "a/b",
        1,
      );
      expect(moved.name).toBe("a/b");
    } finally {
      s.db.close();
    }
  });

  test("keeps a file over a lowered cap renameable", () => {
    const s = setup();
    try {
      const file = s.knowledge.create(
        s.projectId,
        s.author,
        "big.md",
        "x".repeat(64),
      );
      s.caps.knowledgeFileBytes = 1;
      expect(
        s.knowledge.rename(s.projectId, s.author, file.id, "big2.md", 1).name,
      ).toBe("big2.md");
    } finally {
      s.db.close();
    }
  });

  test("a missing file is a 404", () => {
    const s = setup();
    try {
      expect(() =>
        s.knowledge.rename(s.projectId, s.author, "zzzzzzzzzzzz", "b.md", 1),
      ).toThrow(NotFound);
    } finally {
      s.db.close();
    }
  });

  test.serial("publishes one event with the new name", () => {
    const s = setup();
    const events: BusEvent[] = [];
    const off = subscribe((event) => {
      if (
        event.type === "knowledge.changed" &&
        event.data.projectId === s.projectId
      ) {
        events.push(event);
      }
    }, silent);
    try {
      const file = s.knowledge.create(s.projectId, s.author, "a.md", "one");
      events.length = 0;
      s.knowledge.rename(s.projectId, s.author, file.id, "b.md", 1);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "knowledge.changed",
        data: {
          projectId: s.projectId,
          deleted: false,
          file: { id: file.id, name: "b.md", revision: 2 },
        },
      });
    } finally {
      off();
      s.db.close();
    }
  });

  test.each([
    [{ name: "a.md" }, "revision must be a positive integer"],
    [{ name: "a.md", revision: 0 }, "revision must be a positive integer"],
    [{ name: "../a", revision: 1 }, "name must be"],
    [{ name: "a.md", revision: 1, text: "x" }, "unknown field text"],
  ])("refuses the body %j", (body, words) => {
    expect(() => parseRename(body)).toThrow(words);
  });
  test("a delete after a rename is binned and restored under the new name", () => {
    const s = setup();
    try {
      const file = s.knowledge.create(
        s.projectId,
        s.author,
        "old.md",
        "text\n",
      );
      s.knowledge.rename(s.projectId, s.author, file.id, "new.md", 1);
      s.knowledge.remove(s.projectId, s.author, file.id);
      const [binned] = s.knowledge.list(s.projectId).deleted;
      expect(binned).toMatchObject({ id: file.id, name: "new.md" });
      expect(s.knowledge.list(s.projectId).deleted).toHaveLength(1);
      const versions = s.knowledge.versions(s.projectId, file.id);
      expect(versions.map((v) => [v.name, v.deleted])).toEqual([
        ["new.md", true],
        ["new.md", false],
        ["old.md", false],
      ]);
      // a restore is a create of the kept text under the binned name
      const text = s.knowledge.version(s.projectId, versions[1]!.id).text;
      const restored = s.knowledge.create(
        s.projectId,
        s.author,
        "new.md",
        text,
      );
      expect(restored.id).not.toBe(file.id);
      expect(s.knowledge.read(s.projectId, restored.id).text).toBe("text\n");
      expect(s.knowledge.list(s.projectId).deleted).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  test("eviction after renames keeps the newest versions under the id", () => {
    const s = setup({ knowledgeVersions: 2 });
    try {
      const file = s.knowledge.create(s.projectId, s.author, "a.md", "text\n");
      s.knowledge.rename(s.projectId, s.author, file.id, "b.md", 1);
      s.knowledge.rename(s.projectId, s.author, file.id, "c.md", 2);
      s.knowledge.rename(s.projectId, s.author, file.id, "d.md", 3);
      expect(
        s.knowledge
          .versions(s.projectId, file.id)
          .map((v) => [v.revision, v.name]),
      ).toEqual([
        [4, "d.md"],
        [3, "c.md"],
      ]);
    } finally {
      s.db.close();
    }
  });

  test.each(["edit", "delete", "create"] as const)(
    "a command that mounted the old name and %s after a rename fails whole",
    async (race) => {
      const s = setup();
      try {
        const file = s.knowledge.create(
          s.projectId,
          s.author,
          "old.md",
          "first\n",
        );
        const write = {
          edit: "echo edit > old.md",
          delete: "rm old.md",
          create: "echo made > new.md",
        }[race];
        afterMountRead(s, () =>
          s.knowledge.rename(s.projectId, s.author, file.id, "new.md", 1),
        );
        const result = await run(s, `${write}; echo other > other.md`);
        expect(result.error).toBe(true);
        expect(result.content).toContain(
          `${race === "create" ? "new.md" : "old.md"} changed while the command ran, read it again`,
        );
        expect(s.knowledge.list(s.projectId).files.map((f) => f.name)).toEqual([
          "new.md",
        ]);
        expect(s.knowledge.read(s.projectId, file.id)).toMatchObject({
          name: "new.md",
          text: "first\n",
          revision: 2,
        });
      } finally {
        s.db.close();
      }
    },
  );

  test("a command that left the renamed file alone commits", async () => {
    const s = setup();
    try {
      const file = s.knowledge.create(
        s.projectId,
        s.author,
        "old.md",
        "first\n",
      );
      afterMountRead(s, () =>
        s.knowledge.rename(s.projectId, s.author, file.id, "new.md", 1),
      );
      const result = await run(s, "cat old.md; echo other > other.md");
      expect(result.error).toBeFalsy();
      expect(s.knowledge.list(s.projectId).files.map((f) => f.name)).toEqual([
        "new.md",
        "other.md",
      ]);
    } finally {
      s.db.close();
    }
  });
});
