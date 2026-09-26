// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  addedByDay,
  areaBars,
  areasFoot,
  cleanedLine,
  factsLine,
  freeWords,
  growthDay,
  growthWords,
  largestLine,
  logHeights,
  perDay,
  pickedArea,
  rowsDay,
  rowsTile,
  tableBars,
  walWords,
} from "../../../src/client/views/admin/Storage.model.ts";
import type {
  LargestRow,
  StorageArea,
  StorageFile,
} from "../../../src/shared/api/admin.ts";

const MB = 1024 * 1024;

const chats: StorageArea = {
  key: "chats",
  bytes: 30 * MB,
  rows: 1200,
  tables: [
    { name: "messages", bytes: 20 * MB, rows: 1000 },
    { name: "sessions", bytes: 2 * MB, rows: 200 },
  ],
  indexes: { count: 5, bytes: 8 * MB },
};
const usage: StorageArea = {
  key: "usage",
  bytes: 10 * MB,
  rows: 1,
  tables: [{ name: "usage", bytes: 10 * MB, rows: 1 }],
  indexes: { count: 0, bytes: 0 },
};

const row = (over: Partial<LargestRow>): LargestRow => ({
  id: "p1",
  name: "platform",
  project: null,
  owner: null,
  bytes: 5 * MB,
  parts: [],
  messages: null,
  runs: null,
  retentionDays: null,
  ...over,
});

describe("storage words", () => {
  test("areas carry their share of the whole and the foot sums them", () => {
    const bars = areaBars([chats, usage]);
    expect(bars.map((b) => [b.name, b.size, b.share])).toEqual([
      ["Chats", "30 MB", "75%"],
      ["Usage", "10 MB", "25%"],
    ]);
    expect(bars[1].hint).toBe("Usage · 10 MB · 1 row");
    expect(areasFoot([chats, usage])).toBe("40 MB in 2 areas · 1,201 rows");
  });

  test("an area's indexes are one faint line, never named", () => {
    const bars = tableBars(chats);
    expect(bars.map((b) => [b.name, b.faint])).toEqual([
      ["messages", false],
      ["sessions", false],
      ["5 indexes", true],
    ]);
    expect(bars[2].hint).toBe("5 indexes · 8 MB");
    expect(tableBars(usage).some((b) => b.faint)).toBe(false);
  });

  test("a pick not in the answer falls back to the largest area", () => {
    expect(pickedArea([chats, usage], "usage")?.key).toBe("usage");
    expect(pickedArea([chats, usage], "memory")?.key).toBe("chats");
    expect(pickedArea([], null)).toBeNull();
  });

  test("the sparkline sums what each day added", () => {
    const days = [
      { day: "2026-09-22", start: 1, bytes: 10, rows: 1 },
      { day: "2026-09-23", start: 2, bytes: 20, rows: 2 },
      { day: "2026-09-24", start: 3, bytes: 5, rows: 1 },
    ];
    expect(addedByDay(days)).toEqual([10, 30, 35]);
  });

  test("the database size counts rows, and a day the rows it added", () => {
    expect(rowsTile([chats, usage])).toEqual({
      figure: "1.2K",
      unit: "rows",
      sub: "3 tables",
    });
    expect(rowsTile([])).toEqual({
      figure: "0",
      unit: "rows",
      sub: "0 tables",
    });
    const day = (rows: number) => ({
      day: "2026-09-22",
      start: Date.UTC(2026, 8, 22, 12),
      bytes: 0,
      rows,
    });
    expect(rowsDay(day(1))).toBe("22 Sep · 1 row");
    expect(logHeights([0, 9, 999])).toEqual([0, 1, 3]);
    expect(rowsDay(day(1204))).toBe("22 Sep · 1,204 rows");
  });

  test("growth is an average a day", () => {
    expect(perDay(30 * MB, 30)).toEqual({ figure: "+1", unit: "MB a day" });
    expect(perDay(0, 0)).toEqual({ figure: "+0", unit: "B a day" });
    expect(growthWords(0, 30)).toBe("last 30 days");
    expect(growthDay(Date.UTC(2026, 8, 22, 12), 12 * MB)).toBe(
      "22 Sep · +12 MB",
    );
    expect(growthWords(3 * MB, 30)).toBe("last 30 days · was 102 KB");
  });

  const file: StorageFile = {
    name: "1ctx.sqlite",
    bytes: 100 * MB,
    walBytes: 4 * MB,
    shmBytes: 32 * 1024,
    pageSize: 4096,
    pages: 25600,
    freePages: 2560,
    autoVacuum: "none",
    journalMode: "wal",
    sqliteVersion: "3.51.0",
    lastMigration: "0020-mcp-kept",
  };

  test("reusable space and the file facts", () => {
    expect(freeWords(file)).toBe("10% reusable");
    expect(walWords(file)).toBe("4%");
    expect(factsLine(file)).toBe(
      "1ctx.sqlite · 25,600 pages of 4 KB · WAL journal · auto vacuum off · shared memory 32 KB · SQLite 3.51.0 · last migration 0020-mcp-kept",
    );
  });

  test("a personal project's rows name the owner and lead nowhere", () => {
    const personal = row({ id: null, name: null, owner: "alice" });
    expect(largestLine("projects", personal)).toMatchObject({
      name: "personal of @alice",
      href: null,
    });
    expect(largestLine("chats", personal)).toMatchObject({
      name: "A chat in a personal project",
      href: null,
    });
    expect(largestLine("tasks", personal).href).toBeNull();
  });

  test("team rows lead to their page and say what makes them big", () => {
    expect(
      largestLine(
        "projects",
        row({
          parts: [
            { part: "history", bytes: 38 * MB },
            { part: "uploads", bytes: 12 * MB },
            { part: "chats", bytes: MB },
          ],
        }),
      ),
    ).toEqual({
      name: "platform",
      mono: true,
      sub: "knowledge history 38\u00a0MB · uploads 12\u00a0MB",
      href: "/admin/projects?open=p1",
    });
    const chat = row({
      id: "s1",
      name: "Upgrade plan",
      project: "platform",
      messages: 1204,
      parts: [{ part: "chats", bytes: MB }],
    });
    expect(largestLine("chats", chat)).toMatchObject({
      sub: "#platform · 1,204 messages",
      href: "/chat/s1",
    });
    const task = row({
      id: "a1",
      name: "digest",
      project: "platform",
      runs: 90,
      retentionDays: 30,
    });
    expect(largestLine("tasks", task)).toMatchObject({
      sub: "#platform · 90 runs kept 30 days",
      href: "/automations/a1",
    });
  });

  test("a cleaned line names its setting when there is one", () => {
    expect(cleanedLine("scratch", 7).sub).toBe("idle 7 days");
    expect(cleanedLine("runs", null).sub).toBe("by each task's retention");
    expect(cleanedLine("history", 90).sub).toBe("after 90 days");
  });
});
