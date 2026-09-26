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
import { afterMountRead, run, setup } from "./helpers.ts";

describe("knowledge rename", () => {
  test("keeps the id and the text and writes one version", () => {
    const s = setup();
    try {
      const file = s.area.create(s.projectId, s.author, "docs/a.md", "text\n");
      s.now.value = 200;
      const renamed = s.area.rename(
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
      expect(s.area.read(s.projectId, file.id).text).toBe("text\n");
      expect(s.area.store.byName(s.projectId, "docs/a.md")).toBeNull();
      const versions = s.area.versions(s.projectId, file.id);
      expect(versions.map((v) => [v.revision, v.name])).toEqual([
        [2, "notes/b.ts"],
        [1, "docs/a.md"],
      ]);
      expect(s.area.version(s.projectId, versions[0]!.id).text).toBe("text\n");
      expect(s.area.list(s.projectId).deleted).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  test("refuses a stale revision with the replace's words", () => {
    const s = setup();
    try {
      const file = s.area.create(s.projectId, s.author, "a.md", "one");
      s.area.replace(s.projectId, s.author, file.id, "two", 1);
      expect(() =>
        s.area.rename(s.projectId, s.author, file.id, "b.md", 1),
      ).toThrow(new Conflict("a.md is at revision 2"));
    } finally {
      s.db.close();
    }
  });

  test("refuses a taken name, a prefix clash and the same name", () => {
    const s = setup();
    try {
      const file = s.area.create(s.projectId, s.author, "a.md", "one");
      s.area.create(s.projectId, s.author, "b.md", "two");
      s.area.create(s.projectId, s.author, "dir/c.md", "three");
      expect(() =>
        s.area.rename(s.projectId, s.author, file.id, "b.md", 1),
      ).toThrow(new Conflict("a file named b.md exists"));
      expect(() =>
        s.area.rename(s.projectId, s.author, file.id, "dir", 1),
      ).toThrow(new Conflict("dir/c.md conflicts with file dir"));
      expect(() =>
        s.area.rename(s.projectId, s.author, file.id, "b.md/x", 1),
      ).toThrow(new Conflict("b.md/x conflicts with file b.md"));
      expect(() =>
        s.area.rename(s.projectId, s.author, file.id, "a.md", 1),
      ).toThrow(new BadRequest("the file is named a.md already"));
      expect(s.area.read(s.projectId, file.id).revision).toBe(1);
    } finally {
      s.db.close();
    }
  });

  test("a file may move under its own old name", () => {
    const s = setup();
    try {
      const file = s.area.create(s.projectId, s.author, "a", "one");
      const moved = s.area.rename(s.projectId, s.author, file.id, "a/b", 1);
      expect(moved.name).toBe("a/b");
    } finally {
      s.db.close();
    }
  });

  test("keeps a file over a lowered cap renameable", () => {
    const s = setup();
    try {
      const file = s.area.create(
        s.projectId,
        s.author,
        "big.md",
        "x".repeat(64),
      );
      s.caps.knowledgeFileBytes = 1;
      expect(
        s.area.rename(s.projectId, s.author, file.id, "big2.md", 1).name,
      ).toBe("big2.md");
    } finally {
      s.db.close();
    }
  });

  test("a missing file is a 404", () => {
    const s = setup();
    try {
      expect(() =>
        s.area.rename(s.projectId, s.author, "zzzzzzzzzzzz", "b.md", 1),
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
      const file = s.area.create(s.projectId, s.author, "a.md", "one");
      events.length = 0;
      s.area.rename(s.projectId, s.author, file.id, "b.md", 1);
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
      const file = s.area.create(s.projectId, s.author, "old.md", "text\n");
      s.area.rename(s.projectId, s.author, file.id, "new.md", 1);
      s.area.remove(s.projectId, s.author, file.id);
      const [binned] = s.area.list(s.projectId).deleted;
      expect(binned).toMatchObject({ id: file.id, name: "new.md" });
      expect(s.area.list(s.projectId).deleted).toHaveLength(1);
      const versions = s.area.versions(s.projectId, file.id);
      expect(versions.map((v) => [v.name, v.deleted])).toEqual([
        ["new.md", true],
        ["new.md", false],
        ["old.md", false],
      ]);
      // a restore is a create of the kept text under the binned name
      const text = s.area.version(s.projectId, versions[1]!.id).text;
      const restored = s.area.create(s.projectId, s.author, "new.md", text);
      expect(restored.id).not.toBe(file.id);
      expect(s.area.read(s.projectId, restored.id).text).toBe("text\n");
      expect(s.area.list(s.projectId).deleted).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  test("eviction after renames keeps the newest versions under the id", () => {
    const s = setup({ knowledgeVersions: 2 });
    try {
      const file = s.area.create(s.projectId, s.author, "a.md", "text\n");
      s.area.rename(s.projectId, s.author, file.id, "b.md", 1);
      s.area.rename(s.projectId, s.author, file.id, "c.md", 2);
      s.area.rename(s.projectId, s.author, file.id, "d.md", 3);
      expect(
        s.area.versions(s.projectId, file.id).map((v) => [v.revision, v.name]),
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
        const file = s.area.create(s.projectId, s.author, "old.md", "first\n");
        const write = {
          edit: "echo edit > old.md",
          delete: "rm old.md",
          create: "echo made > new.md",
        }[race];
        afterMountRead(s, () =>
          s.area.rename(s.projectId, s.author, file.id, "new.md", 1),
        );
        const result = await run(s, `${write}; echo other > other.md`);
        expect(result.error).toBe(true);
        expect(result.content).toContain(
          `${race === "create" ? "new.md" : "old.md"} changed while the command ran, read it again`,
        );
        expect(s.area.list(s.projectId).files.map((f) => f.name)).toEqual([
          "new.md",
        ]);
        expect(s.area.read(s.projectId, file.id)).toMatchObject({
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
      const file = s.area.create(s.projectId, s.author, "old.md", "first\n");
      afterMountRead(s, () =>
        s.area.rename(s.projectId, s.author, file.id, "new.md", 1),
      );
      const result = await run(s, "cat old.md; echo other > other.md");
      expect(result.error).toBeFalsy();
      expect(s.area.list(s.projectId).files.map((f) => f.name)).toEqual([
        "new.md",
        "other.md",
      ]);
    } finally {
      s.db.close();
    }
  });
});
