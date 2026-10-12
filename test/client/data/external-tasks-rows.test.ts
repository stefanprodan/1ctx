// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The external tasks' pure row rules: the order a member acts in, the
// revision rule, a frame moving a task between the unfinished list and
// the closed pages, Home's marked rows, and the entries read again.

import { describe, expect, test } from "bun:test";
import {
  appendEntries,
  applyMarked,
  applyTask,
  closedTakes,
  dropMarked,
  dropTask,
  mergeEntries,
  reconcile,
  sameClosed,
  type TaskLists,
  taskFields,
  upsertClosed,
  upsertTask,
} from "../../../src/client/data/external-tasks-rows.ts";
import type {
  ExternalTaskEntry,
  ExternalTaskRow,
} from "../../../src/shared/contracts/external-task.ts";

const taskRow = (changes: Partial<ExternalTaskRow> = {}): ExternalTaskRow => ({
  id: "t1",
  projectId: "p1",
  title: "Wire the sweep",
  scope: null,
  state: "open",
  revision: 1,
  editRevision: 0,
  claim: null,
  last: null,
  entries: 0,
  attentionAt: null,
  createdBy: { id: "u1", username: "casey" },
  createdAt: 1_000,
  movedAt: 1_000,
  ...changes,
});

const entry = (id: string): ExternalTaskEntry => ({
  id,
  kind: "progress",
  text: id,
  links: [],
  by: null,
  keyName: null,
  claimId: null,
  claimEnd: null,
  at: 1_000,
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("the unfinished list", () => {
  test("blocked, then claimed, then open, each latest move first", () => {
    const list = [
      taskRow({ id: "a", state: "open", movedAt: 5 }),
      taskRow({ id: "b", state: "claimed", movedAt: 1 }),
      taskRow({ id: "c", state: "blocked", movedAt: 2 }),
      taskRow({ id: "d", state: "open", movedAt: 9 }),
      taskRow({ id: "e", state: "claimed", movedAt: 7 }),
    ].reduce(upsertTask, [] as ExternalTaskRow[]);
    expect(ids(list)).toEqual(["c", "e", "b", "d", "a"]);
  });

  test("a held row at or above the frame's revision keeps its word", () => {
    const held = [taskRow({ revision: 4, state: "claimed" })];
    expect(upsertTask(held, taskRow({ revision: 4 }))).toBe(held);
    expect(upsertTask(held, taskRow({ revision: 3 }))).toBe(held);
    expect(upsertTask(held, taskRow({ revision: 5 }))[0].state).toBe("open");
  });

  test("a closed row leaves it", () => {
    const held = [taskRow({ revision: 2 })];
    expect(upsertTask(held, taskRow({ revision: 3, state: "done" }))).toEqual(
      [],
    );
  });

  test("a list's answer keeps a newer held row and drops one it lacks", () => {
    const held = [
      taskRow({ id: "a", revision: 5, state: "claimed" }),
      taskRow({ id: "b", revision: 1 }),
    ];
    const answer = [taskRow({ id: "a", revision: 4 }), taskRow({ id: "c" })];
    const list = reconcile(held, answer);
    expect(ids(list)).toEqual(["a", "c"]);
    expect(list[0].revision).toBe(5);
  });
});

describe("a frame on a project's lists", () => {
  const lists = (changes: Partial<TaskLists> = {}): TaskLists => ({
    tasks: [taskRow({ id: "a", revision: 2, state: "claimed" })],
    closed: 3,
    pages: null,
    ...changes,
  });

  test("a close moves the task out and counts it", () => {
    const next = applyTask(
      lists(),
      taskRow({ id: "a", revision: 3, state: "done", entries: 2 }),
    );
    expect(next.tasks).toEqual([]);
    expect(next.closed).toBe(4);
  });

  test("a closed task lands on the pages read, latest close first", () => {
    const pages = {
      rows: [taskRow({ id: "z", state: "dropped", movedAt: 500 })],
      next: null,
    };
    const next = applyTask(
      lists({ pages }),
      taskRow({ id: "a", revision: 3, state: "done", movedAt: 900 }),
    );
    expect(ids(next.pages?.rows ?? [])).toEqual(["a", "z"]);
  });

  test("a closed task past the paging cursor waits for its page", () => {
    const pages = {
      rows: [taskRow({ id: "z", state: "dropped", movedAt: 500 })],
      next: "cursor",
    };
    const next = applyTask(
      lists({ pages, tasks: [] }),
      taskRow({ id: "y", revision: 3, state: "done", movedAt: 100 }),
    );
    expect(ids(next.pages?.rows ?? [])).toEqual(["z"]);
  });

  test("a reopen leaves the closed pages and the count", () => {
    const pages = {
      rows: [taskRow({ id: "z", state: "done", revision: 4 })],
      next: null,
    };
    const next = applyTask(
      lists({ pages }),
      taskRow({ id: "z", state: "open", revision: 5, entries: 3 }),
    );
    expect(ids(next.tasks)).toEqual(["a", "z"]);
    expect(next.pages?.rows).toEqual([]);
    expect(next.closed).toBe(2);
  });

  test("a reopen of a task on no page read leaves the count too", () => {
    const next = applyTask(
      lists(),
      taskRow({ id: "q", state: "open", revision: 9, entries: 4 }),
    );
    expect(next.closed).toBe(2);
  });

  test("a new task joins and leaves the closed count alone", () => {
    const next = applyTask(lists(), taskRow({ id: "n", entries: 0 }));
    expect(ids(next.tasks)).toEqual(["a", "n"]);
    expect(next.closed).toBe(3);
  });

  test("an older frame changes nothing", () => {
    const held = lists();
    expect(applyTask(held, taskRow({ id: "a", revision: 1 }))).toBe(held);
  });

  test("a delete of an unfinished task keeps the count, a closed one not", () => {
    expect(dropTask(lists(), "a")).toEqual({
      tasks: [],
      closed: 3,
      pages: null,
    });
    expect(dropTask(lists(), "gone").closed).toBe(2);
  });
});

describe("Home's marked tasks", () => {
  test("a mark joins latest first and counts, a cleared one leaves", () => {
    const marked = {
      tasks: [taskRow({ id: "a", attentionAt: 100 })],
      count: 1,
    };
    const more = applyMarked(
      marked,
      taskRow({ id: "b", attentionAt: 200, revision: 2 }),
    );
    expect(ids(more.tasks)).toEqual(["b", "a"]);
    expect(more.count).toBe(2);
    const cleared = applyMarked(
      more,
      taskRow({ id: "a", attentionAt: null, revision: 2 }),
    );
    expect(ids(cleared.tasks)).toEqual(["b"]);
    expect(cleared.count).toBe(1);
  });

  test("an unmarked row not held changes nothing", () => {
    const marked = { tasks: [], count: 0 };
    expect(applyMarked(marked, taskRow())).toEqual(marked);
  });

  test("a delete drops a held row only", () => {
    const marked = { tasks: [taskRow({ attentionAt: 1 })], count: 60 };
    expect(dropMarked(marked, "t1")).toEqual({ tasks: [], count: 59 });
    expect(dropMarked(marked, "other")).toBe(marked);
  });
});

describe("the closed pages", () => {
  test("latest close first, an older revision keeps the held row", () => {
    const list = [
      taskRow({ id: "a", state: "done", movedAt: 1 }),
      taskRow({ id: "b", state: "dropped", movedAt: 3, revision: 4 }),
    ].reduce(upsertClosed, [] as ExternalTaskRow[]);
    expect(ids(list)).toEqual(["b", "a"]);
    expect(upsertClosed(list, taskRow({ id: "b", revision: 3 }))).toBe(list);
  });

  test("a search reads the title, the scope and both users' names", () => {
    const claim = {
      id: "c1",
      userId: "u2",
      username: "robin",
      keyId: "k1",
      keyName: "laptop",
      startedAt: 1,
    };
    expect(taskFields(taskRow({ scope: "api", claim }))).toEqual([
      "Wire the sweep",
      "api",
      "casey",
      "robin",
    ]);
    expect(taskFields(taskRow({ createdBy: null }))).toEqual([
      "Wire the sweep",
    ]);
  });

  test("a filter takes only its state and its search", () => {
    const done = taskRow({ state: "done", scope: "API" });
    const dropped = taskRow({ state: "dropped" });
    expect(closedTakes({ q: "", state: null })(done)).toBe(true);
    expect(closedTakes({ q: "", state: null })(taskRow())).toBe(false);
    expect(closedTakes({ q: "", state: "done" })(dropped)).toBe(false);
    expect(closedTakes({ q: " api ", state: "done" })(done)).toBe(true);
    expect(closedTakes({ q: "CASEY", state: null })(dropped)).toBe(true);
    expect(closedTakes({ q: "robin", state: null })(dropped)).toBe(false);
  });

  test("a frame's closed row matches as the server's LIKE does", () => {
    const row = taskRow({ state: "dropped", title: "Überprüfung der Logs" });
    const takes = (q: string) => closedTakes({ q, state: null })(row);
    // ASCII letters fold, every other letter is as written
    expect(takes("LOGS")).toBe(true);
    expect(takes("Über")).toBe(true);
    expect(takes("über")).toBe(false);
    expect(takes("ÜBER")).toBe(true);
    expect(takes("üBER")).toBe(false);
    // a closed task holds no claim, so a name left on one never matches
    const claim = {
      id: "c1",
      userId: "u2",
      username: "robin",
      keyId: "k1",
      keyName: "laptop",
      startedAt: 1,
    };
    expect(closedTakes({ q: "robin", state: null })({ ...row, claim })).toBe(
      false,
    );
    expect(
      sameClosed({ q: "api ", state: null }, { q: "api", state: null }),
    ).toBe(true);
    expect(
      sameClosed({ q: "api", state: null }, { q: "api", state: "done" }),
    ).toBe(false);
  });

  test("a frame lands on filtered pages only when the filter takes it", () => {
    const pages = {
      rows: [taskRow({ id: "z", state: "done", movedAt: 500 })],
      next: null,
    };
    const held: TaskLists = { tasks: [], closed: 1, pages };
    const filter = { q: "", state: "done" } as const;
    const dropped = applyTask(
      held,
      taskRow({ id: "y", state: "dropped", revision: 2, movedAt: 900 }),
      filter,
    );
    expect(ids(dropped.pages?.rows ?? [])).toEqual(["z"]);
    expect(dropped.closed).toBe(1);
    const done = applyTask(
      held,
      taskRow({ id: "y", state: "done", revision: 2, movedAt: 900 }),
      filter,
    );
    expect(ids(done.pages?.rows ?? [])).toEqual(["y", "z"]);
    const searched = applyTask(
      held,
      taskRow({ id: "y", state: "done", revision: 2, movedAt: 900 }),
      { q: "other", state: null },
    );
    expect(ids(searched.pages?.rows ?? [])).toEqual(["z"]);
  });
});

describe("the entries", () => {
  test("a first page read again keeps the older pages held", () => {
    const held = {
      entries: ["e5", "e4", "e3", "e2"].map(entry),
      next: "e2",
    };
    const page = { entries: ["e6", "e5", "e4"].map(entry), next: "e4" };
    expect(mergeEntries(held, page)).toEqual({
      entries: ["e6", "e5", "e4", "e3", "e2"].map(entry),
      next: "e2",
    });
  });

  test("a gap starts the pages over", () => {
    const held = { entries: ["e2", "e1"].map(entry), next: "e1" };
    const page = { entries: ["e9", "e8"].map(entry), next: "e8" };
    expect(mergeEntries(held, page)).toBe(page);
  });

  test("a first page that is the whole timeline is taken whole", () => {
    const held = { entries: ["e1"].map(entry), next: null };
    const page = { entries: ["e2", "e1"].map(entry), next: null };
    expect(mergeEntries(held, page)).toBe(page);
  });

  test("a later page never repeats an entry", () => {
    expect(
      appendEntries(["e3", "e2"].map(entry), ["e2", "e1"].map(entry)).map(
        (e) => e.id,
      ),
    ).toEqual(["e3", "e2", "e1"]);
  });
});
