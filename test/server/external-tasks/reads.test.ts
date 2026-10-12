// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import type {
  ExternalTaskEntry,
  ExternalTaskRow,
} from "../../../src/shared/contracts/external-task.ts";
import {
  ATTENTION_ROWS,
  ENTRIES_PAGE,
} from "../../../src/shared/contracts/external-task.ts";
import { MAX_LAST_LINE } from "../../../src/shared/contracts/session.ts";
import { EXTERNAL_TASK_STATES } from "../../../src/shared/words.ts";
import { fixture, refuses } from "./fixture.ts";

test("unfinished tasks are grouped blocked, claimed, open and newest first", () => {
  using f = fixture();
  const oldBlocked = f.task("blocked");
  f.advance();
  const open = f.task("open");
  f.advance();
  const oldClaimed = f.task("claimed");
  f.advance();
  const blocked = f.task("blocked");
  f.advance();
  const claimed = f.task("claimed");
  const done = f.task("done");
  f.task("cancelled");
  f.create("Hidden", f.otherProjectId);
  const result = f.area.byProject(f.projectId);
  expect(result.tasks.map((t) => t.id)).toEqual([
    blocked.id,
    oldBlocked.id,
    claimed.id,
    oldClaimed.id,
    open.id,
  ]);
  expect(result.closed).toBe(2);
  expect(result.idleHours).toBe(24);
  expect(f.area.projectOf(done.id)).toBe(f.projectId);
  expect(f.area.projectOf("missing")).toBeNull();
  expect(f.area.show("missing", null)).toBeNull();
});

test("closed cursor pages the close time and id, surviving a deleted cursor row", () => {
  using f = fixture();
  const rows = [f.task("done"), f.task("cancelled"), f.task("done")];
  f.advance();
  rows.push(f.task("done"), f.task("cancelled"));
  const expected = rows
    .sort((a, b) => b.movedAt - a.movedAt || a.id.localeCompare(b.id))
    .map((r) => r.id);
  const first = f.area.closed(f.projectId, null, undefined, 2);
  expect(first.tasks.map((r) => r.id)).toEqual(expected.slice(0, 2));
  expect(first.next).not.toBeNull();
  f.area.delete(first.tasks.at(-1)!.id);
  f.advance();
  f.task("done");
  const second = f.area.closed(f.projectId, first.next, undefined, 2);
  const last = f.area.closed(f.projectId, second.next, undefined, 2);
  expect([...second.tasks, ...last.tasks].map((r) => r.id)).toEqual(
    expected.slice(2),
  );
  expect(last.next).toBeNull();
  for (const cursor of [
    "bad",
    "-1.abcdefghijkl",
    "1.abc",
    "9007199254740992.abcdefghijkl",
  ]) {
    refuses(() => f.area.closed(f.projectId, cursor), 400, "invalid cursor");
  }
});

test("a filtered closed page keeps its cursor through the rows it skips", () => {
  using f = fixture();
  const kept: { id: string; movedAt: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const row = f.task(i % 2 === 0 ? "done" : "cancelled");
    if (i % 2 === 0) kept.push(row);
    f.create(`Open ${i}`);
    f.advance();
  }
  // three kept and one skipped close in the same millisecond, so the
  // first page ends inside the tie and the id breaks it
  const tie = f.now();
  for (const state of ["done", "cancelled", "done", "done"] as const) {
    const row = f.task(state);
    expect(row.movedAt).toBe(tie);
    if (state === "done") kept.push(row);
  }
  const order = kept
    .sort((a, b) => b.movedAt - a.movedAt || a.id.localeCompare(b.id))
    .map((row) => row.id);
  const filter = { q: "WORK", state: "done" } as const;
  const pages: string[][] = [];
  const cursors: (string | null)[] = [];
  let after: string | null = null;
  do {
    const page = f.area.closed(f.projectId, after, filter, 2);
    pages.push(page.tasks.map((row) => row.id));
    after = page.next;
    cursors.push(after);
  } while (after !== null);
  expect(cursors[0]).toStartWith(`${tie}.`);
  expect(pages).toEqual([
    order.slice(0, 2),
    order.slice(2, 4),
    order.slice(4, 6),
    order.slice(6),
  ]);
  expect(f.area.closed(f.projectId, null, { q: "nope", state: null })).toEqual({
    tasks: [],
    next: null,
  });
  expect(
    f.area.closed(f.otherProjectId, null, { q: "work", state: null }).tasks,
  ).toEqual([]);
});

test("agent lists filter projects and states, paging by moves without brief text", () => {
  using f = fixture();
  const open = f.task("open");
  f.advance();
  const claimed = f.task("claimed");
  f.advance();
  const done = f.task("done");
  f.create("Other", f.otherProjectId);
  const base = {
    projectIds: [f.projectId],
    states: [],
    held: null,
    after: null,
    limit: 1,
  };
  expect(f.port.list(base).rows.map((t) => t.id)).toEqual([open.id]);
  const first = f.port.list({ ...base, states: ["open", "claimed", "done"] });
  expect(first.rows[0]!.id).toBe(done.id);
  const second = f.port.list({
    ...base,
    states: ["open", "claimed", "done"],
    after: first.next,
  });
  expect(second.rows[0]!.id).toBe(claimed.id);
  const third = f.port.list({
    ...base,
    states: ["open", "claimed", "done"],
    after: second.next,
  });
  expect(third.rows[0]!.id).toBe(open.id);
  expect(third.next).toBeNull();
  expect(Object.hasOwn(first.rows[0]!, "text")).toBe(false);
  expect(f.port.list({ ...base, projectIds: [] })).toEqual({
    rows: [],
    next: null,
  });
  for (const limit of [0, -1, 501, 1.5])
    refuses(() => f.port.list({ ...base, limit }), 400);
});

test("held lists mark only answers after this claim's last report, including time ties", () => {
  using f = fixture();
  const task = f.task("claimed");
  const other = f.create();
  f.area.claim(f.otherKey, other.id);
  const input = {
    projectIds: [f.projectId],
    states: ["done"] as const,
    held: f.key,
    after: null,
    limit: 50,
  };
  const list = () => f.port.list({ ...input, states: [...input.states] }).rows;
  expect(list().map((r) => [r.id, r.answered])).toEqual([[task.id, false]]);
  f.area.report(f.key, task.id, task.claimId!, "question", "A choice?", []);
  f.area.answer(f.member.id, task.id, { state: "blocked", text: "Go." });
  expect(list()[0]!.answered).toBe(true);
  f.area.report(f.key, task.id, task.claimId!, "progress", "On it.", []);
  expect(list()[0]!.answered).toBe(false);
  f.area.answer(f.member.id, task.id, {
    state: "claimed",
    text: "One more thing.",
  });
  expect(list()[0]!.answered).toBe(true);
  f.area.unclaim(f.member.id, task.id, {
    state: "claimed",
    claimId: task.claimId!,
    text: "Reclaim.",
  });
  f.area.claim(f.key, task.id);
  expect(list()[0]!.answered).toBe(false);
  expect(
    f.port.list({ ...input, states: [], projectIds: [f.otherProjectId] }).rows,
  ).toEqual([]);
});

test("each agent row resumes a merged page, including its last row", () => {
  using f = fixture();
  for (const state of EXTERNAL_TASK_STATES) {
    f.task(state);
    f.advance();
  }
  f.create("Other", f.otherProjectId);
  const other = f.create("Other claim", f.otherProjectId);
  f.area.claim(f.key, other.id);
  for (const held of [null, f.key]) {
    const input = {
      projectIds: [f.projectId, f.otherProjectId, f.projectId],
      states: [...EXTERNAL_TASK_STATES],
      held,
      after: null,
      limit: 50,
    };
    const page = f.port.list(input);
    const expected = [f.projectId, f.otherProjectId]
      .flatMap((id) => [
        ...f.area.byProject(id).tasks,
        ...f.area.closed(id, null).tasks,
      ])
      .filter((row) => held === null || row.claim !== null)
      .sort((a, b) => b.movedAt - a.movedAt || a.id.localeCompare(b.id));
    const ids = expected.map((row) => row.id);
    expect(page.rows.map(({ answered: _, cursor: __, ...row }) => row)).toEqual(
      expected,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(held === null ? 7 : 3);
    for (const [i, row] of page.rows.entries()) {
      expect(row.cursor).toBe(`${row.movedAt}.${row.id}`);
      expect(
        f.port.list({ ...input, after: row.cursor }).rows.map((row) => row.id),
      ).toEqual(ids.slice(i + 1));
    }
    const short = f.port.list({ ...input, limit: 2 });
    expect(short.next).toBe(short.rows[1]!.cursor);
    expect(
      f.port.list({ ...input, after: short.next }).rows.map((row) => row.id),
    ).toEqual(ids.slice(2));
  }
  const row = f.area.closed(f.projectId, null).tasks[0]!;
  expect(Object.hasOwn(row, "cursor")).toBe(false);
  expect(Object.hasOwn(row, "answered")).toBe(false);
});

for (const kind of ["progress", "answer"] as const) {
  test(`${kind} while claimed cannot move a task ahead of a list cursor`, () => {
    using f = fixture();
    const older = f.task("claimed");
    f.advance();
    const newer = f.task("claimed");
    const input = {
      projectIds: [f.projectId],
      states: [],
      held: f.key,
      after: null,
      limit: 1,
    };
    const first = f.port.list(input);
    expect(first.rows[0]!.id).toBe(newer.id);
    f.advance();
    if (kind === "progress") {
      f.port.report(f.key, older.id, older.claimId!, kind, "Working.", []);
    } else {
      f.area.answer(f.member.id, older.id, {
        state: "claimed",
        text: "A hint.",
      });
    }
    const row = f.area.store.byId(older.id)!;
    expect(row.movedAt).toBe(older.movedAt);
    expect(row.revision).toBe(older.revision + 1);
    expect(row.editRevision).toBe(older.editRevision);
    expect(
      f.port.list({ ...input, after: first.next }).rows.map((row) => row.id),
    ).toEqual([older.id]);
  });
}

test("entry pages use time and rowid, so a new entry between pages skips none", () => {
  using f = fixture();
  const task = f.task("claimed");
  // the claim's entry pages with the reports, in the same millisecond
  const entries: ExternalTaskEntry[] = [
    f.port.show(task.id, null)!.entries[0]!,
  ];
  expect(entries[0]!.kind).toBe("claim");
  for (let i = 0; i < ENTRIES_PAGE * 2 + 3; i++) {
    if (i % 25 === 0) f.advance();
    entries.push(
      f.area.report(f.key, task.id, task.claimId!, "progress", `Entry ${i}`, [])
        .entry,
    );
  }
  const first = f.port.show(task.id, null)!;
  expect(first.entries.map((e) => e.id)).toEqual(
    entries
      .toReversed()
      .slice(0, ENTRIES_PAGE)
      .map((e) => e.id),
  );
  expect(first.next).toBe(first.entries.at(-1)!.id);
  f.area.report(
    f.key,
    task.id,
    task.claimId!,
    "progress",
    "Added between pages.",
    [],
  );
  const second = f.port.show(task.id, first.next)!;
  const last = f.port.show(task.id, second.next)!;
  expect(
    [...first.entries, ...second.entries, ...last.entries].map((e) => e.id),
  ).toEqual(entries.toReversed().map((e) => e.id));
  expect(last.next).toBeNull();
  const other = f.task("done");
  refuses(
    () => f.port.show(task.id, f.port.show(other.id, null)!.entries[0]!.id),
    400,
    "invalid entry cursor",
  );
  refuses(() => f.port.show(task.id, "missing"), 400, "invalid entry cursor");
});

test("attention is bounded with a full count and ordered by mark across only the given projects", () => {
  using f = fixture();
  const marked: ExternalTaskRow[] = [];
  for (let i = 0; i < ATTENTION_ROWS + 3; i++) {
    f.advance();
    marked.push(f.task(i % 2 === 0 ? "done" : "blocked"));
  }
  const unmarked = f.task("claimed");
  f.area.unclaim(f.member.id, unmarked.id, {
    state: "claimed",
    claimId: unmarked.claimId!,
    text: "Member unclaim.",
  });
  expect(f.area.store.byId(unmarked.id)!.attentionAt).toBeNull();
  const other = f.create("Other", f.otherProjectId);
  const held = f.area.claim(f.key, other.id);
  f.advance();
  const unclaimed = f.area.report(
    f.key,
    held.task.task.id,
    held.claimId,
    "unclaim",
    "Needs a member.",
    [],
  );
  expect(unclaimed.task.attentionAt).toBe(f.now());
  const result = f.area.attention([f.projectId]);
  expect(result.count).toBe(ATTENTION_ROWS + 3);
  expect(result.tasks.map((r) => r.id)).toEqual(
    marked
      .toReversed()
      .slice(0, ATTENTION_ROWS)
      .map((r) => r.id),
  );
  expect(f.area.attention([f.projectId, f.otherProjectId]).tasks[0]!.id).toBe(
    other.id,
  );
  f.area.seen(result.tasks[0]!.id, {
    attentionAt: result.tasks[0]!.attentionAt!,
  });
  expect(f.area.attention([f.projectId]).count).toBe(ATTENTION_ROWS + 2);
  expect(f.area.attention([])).toEqual({ tasks: [], count: 0 });
});

test("linked files read live names and revisions, then deleted names and a pruned fallback", () => {
  using f = fixture();
  f.files.set(`${f.projectId}/file`, { name: "plan.md", revision: 1 });
  f.files.set(`${f.projectId}/second`, { name: "second.md", revision: 1 });
  const task = f.area.create(f.owner.id, f.projectId, {
    title: "Read the plan",
    text: "Implement it",
    fileIds: ["file", "second"],
  }).task.task;
  const held = f.area.claim(f.key, task.id);
  expect(held.task.files.map((v) => v.fileId)).toEqual(["file", "second"]);
  f.files.set(`${f.projectId}/file`, { name: "renamed.md", revision: 2 });
  expect(f.port.show(task.id, null)!.task.files[0]).toEqual({
    fileId: "file",
    name: "renamed.md",
    revision: 2,
    deleted: false,
  });
  f.files.delete(`${f.projectId}/file`);
  f.deleted.set(`${f.projectId}/file`, "renamed.md");
  expect(f.port.show(task.id, null)!.task.files[0]).toEqual({
    fileId: "file",
    name: "renamed.md",
    revision: null,
    deleted: true,
  });
  f.area.edit(task.id, {
    editRevision: 0,
    text: "Still points at the deleted plan.",
    fileIds: ["file", "second"],
  });
  f.files.set(`${f.projectId}/restored`, { name: "renamed.md", revision: 1 });
  expect(f.port.claim(f.key, task.id).task.files[0]!.deleted).toBe(true);
  f.deleted.clear();
  expect(f.port.show(task.id, null)!.task.files[0]).toEqual({
    fileId: "file",
    name: null,
    revision: null,
    deleted: true,
  });
  f.area.edit(task.id, { editRevision: 1, fileIds: ["restored"] });
  expect(f.port.show(task.id, null)!.task.files).toEqual([
    { fileId: "restored", name: "renamed.md", revision: 1, deleted: false },
  ]);
  f.files.set(`${f.otherProjectId}/foreign`, {
    name: "private.md",
    revision: 1,
  });
  refuses(
    () => f.area.edit(task.id, { editRevision: 2, fileIds: ["foreign"] }),
    400,
    "no such knowledge file",
  );
  refuses(
    () =>
      f.area.create(f.owner.id, f.projectId, {
        title: "No file",
        text: "",
        fileIds: ["missing"],
      }),
    400,
  );
});

test("a new claim leaves the last entry the unclaim before it, on every read", () => {
  using f = fixture();
  const task = f.task("claimed");
  f.area.report(f.key, task.id, task.claimId!, "unclaim", "Later.", []);
  f.advance();
  const held = f.area.claim(f.key, task.id);
  expect(held.entries[0]!.kind).toBe("claim");
  const last = { kind: "unclaim" as const, text: "Later.", at: f.now() - 1 };
  expect(held.task.task.last).toEqual(last);
  expect(f.area.store.byId(task.id)!.last).toEqual(last);
  expect(f.area.byProject(f.projectId).tasks[0]!.last).toEqual(last);
  expect(f.area.attention([f.projectId]).tasks[0]!.last).toEqual(last);
  const listed = f.area.list({
    projectIds: [f.projectId],
    states: ["claimed"],
    held: null,
    after: null,
    limit: 10,
  });
  expect(listed.rows[0]!.last).toEqual(last);
});

test("last entry previews are one bounded line without a split surrogate", () => {
  using f = fixture();
  const task = f.task("claimed");
  const text = `\n## **First** ${"\u{1f600}".repeat(MAX_LAST_LINE)}\nLater line`;
  const row = f.area.report(
    f.key,
    task.id,
    task.claimId!,
    "progress",
    text,
    [],
  ).task;
  expect(row.last!.text.length).toBeLessThanOrEqual(MAX_LAST_LINE);
  expect(row.last!.text).not.toContain("\n");
  expect(row.last!.text.startsWith("First ")).toBe(true);
  expect(row.last!.text).not.toContain("**");
  expect(row.last!.text).not.toContain("Later line");
  expect(row.last!.text.isWellFormed()).toBe(true);
  expect(f.area.show(task.id, null)!.entries[0]!.text).toBe(text);
});

test("last entry previews trim leading whitespace before the SQL text cap", () => {
  using f = fixture();
  const task = f.task("claimed");
  const whitespace =
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004" +
    "\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
  const text = `${whitespace.repeat(30)}## **Visible** first line\nLater line`;
  f.area.report(f.key, task.id, task.claimId!, "question", text, []);
  const input = {
    projectIds: [f.projectId],
    states: ["blocked"] as const,
    held: null,
    after: null,
    limit: 1,
  };
  for (const row of [
    f.area.store.byId(task.id)!,
    f.area.byProject(f.projectId).tasks[0]!,
    f.area.attention([f.projectId]).tasks[0]!,
    f.port.list({ ...input, states: [...input.states] }).rows[0]!,
  ]) {
    expect(row.last!.text).toBe("Visible first line");
  }
  expect(f.area.show(task.id, null)!.entries[0]!.text).toBe(text);
});
