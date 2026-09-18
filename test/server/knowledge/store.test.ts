// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { getCommandNames } from "just-bash";
import { transact } from "../../../src/server/db/index.ts";
import { KNOWLEDGE_COMMANDS } from "../../../src/server/knowledge/limits.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { Conflict, NotFound } from "../../../src/server/lib/errors.ts";
import { sha256 } from "../../../src/server/lib/ids.ts";
import { tokens } from "../../../src/server/lib/tokens.ts";
import { setup } from "./helpers.ts";

describe("knowledge store and area", () => {
  test("pins only commands registered by the library", () => {
    const names = getCommandNames();
    for (const command of KNOWLEDGE_COMMANDS) expect(names).toContain(command);
    expect(KNOWLEDGE_COMMANDS).not.toContain("sqlite3");
    expect(KNOWLEDGE_COMMANDS).not.toContain("test");
  });

  test("writes post-images with byte, line, digest, token and author counts", () => {
    const { db, area, projectId, author, agent, now } = setup();
    try {
      const first = area.create(
        projectId,
        author,
        "docs/x.md",
        "\ufeffone\r\n",
      );
      expect(first).toMatchObject({
        name: "docs/x.md",
        kind: "md",
        bytes: 5,
        lines: 1,
        tokens: tokens("one\r\n"),
        revision: 1,
        createdAt: 100,
        updatedAt: 100,
        author,
      });
      expect(first).not.toHaveProperty("text");
      expect(area.store.byId(projectId, first.id)?.digest).toBe(
        sha256("one\r\n"),
      );
      now.value = 200;
      const second = area.replace(projectId, agent, first.id, "two\n", 1);
      expect(second).toMatchObject({
        revision: 2,
        author: agent,
        createdAt: 100,
        updatedAt: 200,
      });
      const versions = area.versions(projectId, first.id);
      expect(versions.map((v) => v.revision)).toEqual([2, 1]);
      expect(versions[0]).not.toHaveProperty("text");
      expect(area.version(projectId, versions[0]!.id).text).toBe("two\n");
      expect(area.version(projectId, versions[1]!.id).text).toBe("one\r\n");
      expect(area.counts(projectId)).toEqual({
        files: 1,
        tokens: tokens("two\n"),
      });
      expect(area.list(projectId).totals.bytes).toBe(4);
      expect(area.snapshot(projectId)).toEqual({
        files: 1,
        recent: [{ name: first.name, author: "coder", updatedAt: 200 }],
      });
      expect(() => area.replace(projectId, author, first.id, "old", 1)).toThrow(
        "docs/x.md is at revision 2",
      );
      expect(area.read(projectId, first.id).text).toBe("two\n");
    } finally {
      db.close();
    }
  });

  test("names are exact and prefix-free, restore creates a new identity", () => {
    const { db, area, projectId, author, agent } = setup();
    try {
      const file = area.create(projectId, author, "docs/x", "old");
      expect(() => area.create(projectId, author, "docs/x", "new")).toThrow(
        "a file named docs/x exists",
      );
      expect(() => area.create(projectId, author, "docs", "new")).toThrow(
        Conflict,
      );
      expect(() => area.create(projectId, author, "docs/x/y", "new")).toThrow(
        Conflict,
      );
      area.create(projectId, author, "Docs", "case-sensitive");
      const deleted = area.remove(projectId, agent, file.id);
      expect(deleted.revision).toBe(2);
      expect(deleted.author).toEqual(agent);
      expect(area.list(projectId).deleted).toEqual([
        {
          ...file,
          deletedBy: agent,
          deletedAt: 100,
        },
      ]);
      const versions = area.versions(projectId, file.id);
      expect(area.version(projectId, versions[0]!.id)).toMatchObject({
        deleted: true,
        text: "",
        bytes: 0,
        lines: 0,
        revision: 2,
        author: agent,
      });
      const restored = area.create(
        projectId,
        author,
        file.name,
        area.version(projectId, versions[1]!.id).text,
      );
      expect(restored.id).not.toBe(file.id);
      expect(restored.revision).toBe(1);
      expect(area.versions(projectId, file.id)).toHaveLength(2);
      // a name that is live again is no longer offered for a restore
      expect(area.list(projectId).deleted.map((row) => row.name)).not.toContain(
        file.name,
      );
      expect(() => area.read(projectId, file.id)).toThrow(NotFound);
      expect(() => area.remove(projectId, author, file.id)).toThrow(NotFound);
      expect(() => area.read("foreign", restored.id)).toThrow(NotFound);
      expect(() => area.versions("foreign", file.id)).toThrow(NotFound);
      expect(() => area.version("foreign", versions[0]!.id)).toThrow(NotFound);
    } finally {
      db.close();
    }
  });

  test("caps measure bytes and allow shrinking after limits are lowered", () => {
    const { db, area, projectId, author, caps } = setup({
      knowledgeFileBytes: 8,
      knowledgeFiles: 2,
      knowledgeProjectBytes: 10,
    });
    try {
      const file = area.create(projectId, author, "one", "12345678");
      expect(() => area.create(projectId, author, "two", "123")).toThrow(
        "11 bytes, the limit is 10",
      );
      expect(() => area.create(projectId, author, "two", "123456789")).toThrow(
        "9 bytes, the limit is 8",
      );
      area.create(projectId, author, "two", "xx");
      expect(() => area.create(projectId, author, "three", "")).toThrow(
        "3 files, the limit is 2",
      );
      caps.knowledgeFiles = 1;
      caps.knowledgeFileBytes = 2;
      caps.knowledgeProjectBytes = 2;
      expect(() =>
        area.replace(projectId, author, file.id, "123456789", 1),
      ).toThrow("9 bytes, the limit is 2");
      const smaller = area.replace(projectId, author, file.id, "1234567", 1);
      expect(smaller.bytes).toBe(7);
      expect(() =>
        area.replace(projectId, author, file.id, "7654321", 2),
      ).toThrow();
      area.remove(projectId, author, file.id);
      expect(area.list(projectId).totals).toMatchObject({ files: 1, bytes: 2 });
    } finally {
      db.close();
    }
  });

  test("evicts by revision and then oldest project bytes without refusing writes", () => {
    const { db, area, projectId, author, caps } = setup({
      knowledgeVersions: 2,
      knowledgeHistoryBytes: 6,
    });
    try {
      const a = area.create(projectId, author, "a", "abc");
      area.replace(projectId, author, a.id, "def", 1);
      area.replace(projectId, author, a.id, "ghi", 2);
      expect(area.versions(projectId, a.id).map((v) => v.revision)).toEqual([
        3, 2,
      ]);
      const b = area.create(projectId, author, "b", "jkl");
      expect(area.versions(projectId, a.id).map((v) => v.revision)).toEqual([
        3,
      ]);
      expect(area.versions(projectId, b.id)).toHaveLength(1);
      caps.knowledgeVersions = 1;
      area.remove(projectId, author, a.id);
      expect(area.versions(projectId, a.id)).toHaveLength(1);
      expect(area.list(projectId).deleted[0]).toMatchObject({
        id: a.id,
        bytes: 3,
        revision: 3,
        createdAt: 100,
        tokens: tokens("ghi"),
      });
      caps.knowledgeHistoryBytes = 1;
      area.replace(projectId, author, b.id, "longer", 1);
      expect(area.versions(projectId, b.id)).toEqual([]);
      expect(area.read(projectId, b.id).text).toBe("longer");
    } finally {
      db.close();
    }
  });

  test("sweeps all history of expired deleted identities, never live versions", () => {
    const { db, area, projectId, author, now } = setup({
      knowledgeHistoryDays: 1,
    });
    try {
      const old = area.create(projectId, author, "old", "old");
      const live = area.create(projectId, author, "live", "live");
      now.value = 200;
      area.remove(projectId, author, old.id);
      const fresh = area.create(projectId, author, "old", "restored");
      expect(area.sweep(200 + 86_400_000)).toBe(0);
      expect(area.sweep(201 + 86_400_000)).toBe(2);
      expect(area.list(projectId).deleted).toEqual([]);
      expect(area.versions(projectId, live.id)).toHaveLength(1);
      expect(area.versions(projectId, fresh.id)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("the snapshot is five newest live files", () => {
    const { db, area, projectId, author, now } = setup();
    try {
      for (let i = 0; i < 7; i++) {
        now.value++;
        area.create(projectId, author, `f${i}`, "");
      }
      expect(area.snapshot(projectId).recent.map((file) => file.name)).toEqual([
        "f6",
        "f5",
        "f4",
        "f3",
        "f2",
      ]);
    } finally {
      db.close();
    }
  });

  test.serial(
    "publishes one event after commit and none after rollback",
    () => {
      const { db, area, projectId, author } = setup();
      const events: BusEvent[] = [];
      const off = subscribe((event) => {
        if (
          event.type === "knowledge.changed" &&
          event.data.projectId === projectId
        ) {
          events.push(event);
          expect(
            area.store.versions(projectId, event.data.file.id),
          ).not.toHaveLength(0);
        }
      });
      try {
        expect(() =>
          transact(db, () => {
            area.create(projectId, author, "rolled-back", "text");
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        expect(events).toEqual([]);
        expect(area.list(projectId).files).toEqual([]);
        const file = area.create(projectId, author, "saved", "text");
        area.replace(projectId, author, file.id, "next", 1);
        area.remove(projectId, author, file.id);
        expect(events).toHaveLength(3);
        expect(events[2]).toMatchObject({
          data: { deleted: true, file: { id: file.id, revision: 3, author } },
        });
      } finally {
        off();
        db.close();
      }
    },
  );
});
