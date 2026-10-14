// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rail's Recent list on fixtures: newest first, five at most, one
// row per key, a row kept in place when its page is opened from the
// list, the pages that record, and a stored list read without trust.

import { describe, expect, test } from "bun:test";
import {
  automationRecent,
  fileRecent,
  keepRecent,
  pushRecent,
  RECENT_MAX,
  type RecentRow,
  readRecent,
  recentHref,
  recentIcon,
  recentKey,
  recentPage,
  recentText,
  sessionRecent,
  taskRecent,
} from "../../../src/client/app/Recent.model.ts";

const chat = (id: string, title = `chat ${id}`): RecentRow =>
  sessionRecent({
    id,
    projectId: "p1",
    origin: "chat",
    automationId: null,
    title,
  });

const run = (id: string, automationId: string | null, title = "Digest") =>
  sessionRecent({
    id,
    projectId: "p1",
    origin: "automation",
    automationId,
    title,
  });

const fill = (n: number): RecentRow[] =>
  Array.from({ length: n }, (_, i) => chat(`c${i}`)).reduceRight<RecentRow[]>(
    (list, row) => pushRecent(list, row),
    [],
  );

const ids = (list: RecentRow[]) => list.map((r) => r.id);

describe("placing a row", () => {
  test("the page opened last goes first, and the sixth falls off", () => {
    let list: RecentRow[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      list = pushRecent(list, chat(id));
    }
    expect(list.length).toBe(RECENT_MAX);
    expect(ids(list)).toEqual(["f", "e", "d", "c", "b"]);
  });

  test("a page opened again moves to the top under its latest title", () => {
    const list = pushRecent(fill(5), chat("c3", "renamed"));
    expect(ids(list)).toEqual(["c3", "c0", "c1", "c2", "c4"]);
    expect(list[0].title).toBe("renamed");
  });

  test("a page opened from Recent changes its row in place", () => {
    const list = keepRecent(fill(5), chat("c3", "renamed"));
    expect(ids(list)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    expect(list[3].title).toBe("renamed");
  });

  test("a row kept in place that is not held goes first", () => {
    expect(ids(keepRecent(fill(5), chat("x")))).toEqual([
      "x",
      "c0",
      "c1",
      "c2",
      "c3",
    ]);
  });

  test("an automation and its run take two rows", () => {
    let list = pushRecent([], automationRecent(auto("a1")));
    list = pushRecent(list, run("r1", "a1"));
    expect(list.map(recentKey)).toEqual(["runs:a1", "automation:a1"]);
  });

  test("two runs of one automation share a row, the one opened last", () => {
    let list = pushRecent([], run("r1", "a1"));
    list = pushRecent(list, chat("c1"));
    list = pushRecent(list, run("r2", "a1"));
    expect(list.map(recentKey)).toEqual(["runs:a1", "chat:c1"]);
    expect(recentHref(list[0])).toBe("/run/r2");
  });

  test("a run whose automation is gone is a row of its own", () => {
    const list = pushRecent(pushRecent([], run("r1", null)), run("r2", null));
    expect(list.map(recentKey)).toEqual(["run:r2", "run:r1"]);
  });
});

const auto = (id: string) => ({ id, projectId: "p1", name: `auto ${id}` });

describe("drawing a row", () => {
  test("each kind has its icon, words and link", () => {
    const rows = [
      chat("c 1"),
      run("r1", "a1"),
      automationRecent(auto("a1")),
      taskRecent({ id: "t1", projectId: "p1", title: "Fix the build" }),
      fileRecent({ id: "f1", projectId: "p 2", name: "plans/x.md" }),
    ];
    expect(rows.map(recentIcon)).toEqual([
      "chat",
      "bolt",
      "clock",
      "task",
      "file-text",
    ]);
    expect(rows.map(recentText)).toEqual([
      "chat c 1",
      "Run of Digest",
      "auto a1",
      "Fix the build",
      "plans/x.md",
    ]);
    expect(rows.map(recentHref)).toEqual([
      "/chat/c%201",
      "/run/r1",
      "/automations/a1",
      "/external-tasks/t1",
      "/projects/p%202/knowledge/files/f1",
    ]);
  });
});

describe("the pages that record", () => {
  test("a chat, a run, an automation and its tabs, a task and a file", () => {
    expect(recentPage("/chat/s1")).toEqual({
      kind: "session",
      id: "s1",
      record: true,
    });
    expect(recentPage("/run/s%201")).toEqual({
      kind: "session",
      id: "s 1",
      record: true,
    });
    expect(recentPage("/automations/a1")?.record).toBe(true);
    expect(recentPage("/automations/a1/memory")).toEqual({
      kind: "automation",
      id: "a1",
      record: true,
    });
    expect(recentPage("/external-tasks/t1")?.kind).toBe("task");
    expect(recentPage("/projects/p1/knowledge/files/f1")).toEqual({
      kind: "file",
      id: "f1",
      record: true,
    });
  });

  test("an edit page is part of its automation's visit, never recorded", () => {
    expect(recentPage("/automations/a1/edit")).toEqual({
      kind: "automation",
      id: "a1",
      record: false,
    });
  });

  test("lists, project pages, new pages and admin pages are no page", () => {
    for (const pathname of [
      "/",
      "/projects",
      "/projects/p1",
      "/projects/p1/automations",
      "/projects/p1/automations/new",
      "/projects/p1/external-tasks",
      "/projects/p1/external-tasks/new",
      "/projects/p1/knowledge",
      "/projects/p1/knowledge/new",
      "/projects/p1/knowledge/path",
      "/directory",
      "/profile",
      "/admin/monitor",
      "/admin/access/users/casey",
      "/chat/%E0%A4%A",
    ]) {
      expect(recentPage(pathname), pathname).toBeNull();
    }
  });
});

describe("reading a stored list", () => {
  const stored = (rows: unknown) => JSON.stringify(rows);

  test("a good list reads back as it was written", () => {
    const list = [
      chat("c1"),
      run("r1", "a1"),
      automationRecent(auto("a1")),
      taskRecent({ id: "t1", projectId: "p1", title: "t" }),
      fileRecent({ id: "f1", projectId: "p1", name: "x.md" }),
    ];
    expect(readRecent(stored(list))).toEqual(list);
  });

  test("nothing, a broken value and a value of the wrong shape read empty", () => {
    expect(readRecent(null)).toEqual([]);
    expect(readRecent("{")).toEqual([]);
    expect(readRecent(stored({ kind: "chat" }))).toEqual([]);
    expect(readRecent(stored("chat"))).toEqual([]);
  });

  test("a row of the wrong shape or an unknown kind is dropped", () => {
    const good = chat("c1");
    const list = readRecent(
      stored([
        null,
        "c1",
        { ...good, kind: "page" },
        { ...good, id: "" },
        { ...good, id: 7 },
        { ...good, projectId: undefined },
        { ...good, title: null },
        { ...good, automationId: "a1" },
        { ...good, automationId: undefined },
        good,
      ]),
    );
    expect(list).toEqual([good]);
  });

  test("a second row of one key and a sixth row are dropped", () => {
    const rows = [chat("c1"), chat("c1", "again"), ...fill(5)];
    expect(ids(readRecent(stored(rows)))).toEqual([
      "c1",
      "c0",
      "c2",
      "c3",
      "c4",
    ]);
  });

  test("fields beyond the row are left behind", () => {
    const [row] = readRecent(
      stored([{ ...chat("c1"), href: "https://elsewhere.test" }]),
    );
    expect(row).toEqual(chat("c1"));
  });

  test("a stored id never leads off the app", () => {
    const [row] = readRecent(stored([chat("//elsewhere.test")]));
    expect(recentHref(row)).toBe("/chat/%2F%2Felsewhere.test");
  });
});
