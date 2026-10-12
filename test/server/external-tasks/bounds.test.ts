// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import {
  CLOSING_ENTRIES,
  MAX_CLAIMS,
  MAX_ENTRIES,
  MAX_UNFINISHED,
} from "../../../src/shared/contracts/external-task.ts";
import { fixture, refuses } from "./fixture.ts";

test("a claim taken at 239 can still end and close, its own entry outside the bound", () => {
  using f = fixture();
  const task = f.create();
  f.fillEntries(task.id, CLOSING_ENTRIES - 1);
  const held = f.area.claim(f.key, task.id);
  const question = f.area.report(
    f.key,
    held.task.task.id,
    held.claimId,
    "question",
    "Need help.",
    [],
  );
  expect(question.task.entries).toBe(241);
  expect(f.area.store.counted(task.id)).toBe(240);
  refuses(
    () =>
      f.area.report(
        f.key,
        held.task.task.id,
        held.claimId,
        "progress",
        "More.",
        [],
      ),
    409,
  );
  refuses(
    () => f.area.answer(f.owner.id, task.id, { state: "blocked", text: "Go." }),
    409,
  );
  const unclaimed = f.area.unclaim(f.owner.id, task.id, {
    state: "blocked",
    claimId: held.claimId,
    text: "Enough.",
  });
  expect(unclaimed.task.task.entries).toBe(242);
  refuses(() => f.area.claim(f.key, task.id), 409, "make a new external task");
  const dropped = f.area.drop(f.owner.id, task.id, { state: "open" });
  expect(dropped.task.task.entries).toBe(243);
  refuses(
    () =>
      f.area.reopen(f.owner.id, task.id, { state: "dropped", text: "More." }),
    409,
    "make a new external task",
  );
});

for (const count of [239, 240, 249, 250]) {
  for (const kind of ["result", "unclaim", "drop"] as const) {
    test(`${kind} at ${count} entries`, () => {
      using f = fixture();
      const task = f.task("blocked");
      f.fillEntries(task.id, count);
      const write = () =>
        kind === "drop"
          ? f.area.drop(f.owner.id, task.id, { state: "blocked" }).task.task
          : f.area.report(f.key, task.id, task.claimId!, kind, "End.", []).task;
      if (count === MAX_ENTRIES) {
        refuses(write, 409, "make a new external task");
        expect(f.area.store.counted(task.id)).toBe(count);
        expect(f.area.store.claimById(task.claimId!)!.ended_at).toBeNull();
      } else expect(write().entries).toBe(count + 2);
    });
  }
}

test("an open task cannot take a claim at 240 entries and a closed one cannot reopen", () => {
  using f = fixture();
  const open = f.create();
  f.fillEntries(open.id, 240);
  refuses(() => f.area.claim(f.key, open.id), 409);
  const done = f.task("done");
  f.fillEntries(done.id, 240);
  refuses(
    () => f.area.reopen(f.owner.id, done.id, { state: "done", text: "More." }),
    409,
  );
  expect(f.area.store.claimsCount(open.id)).toBe(0);
});

test("the twentieth claim works and retries, the twenty-first is refused", () => {
  using f = fixture();
  const task = f.create();
  for (let i = 0; i < MAX_CLAIMS; i++) {
    const held = f.area.claim(f.key, task.id);
    expect(f.area.claim(f.key, task.id).claimId).toBe(held.claimId);
    f.area.report(
      f.key,
      held.task.task.id,
      held.claimId,
      "unclaim",
      "Another try.",
      [],
    );
  }
  refuses(() => f.area.claim(f.key, task.id), 409, "make a new external task");
  expect(f.area.store.claimsCount(task.id)).toBe(MAX_CLAIMS);
  expect(f.area.store.byId(task.id)!.entries).toBe(2 * MAX_CLAIMS);
  expect(f.area.store.counted(task.id)).toBe(MAX_CLAIMS);
});

test("500 unfinished blocks create and reopen, not history or another project", () => {
  using f = fixture();
  const closed = f.task("done");
  transact(f.db, () => {
    for (let i = 0; i < MAX_UNFINISHED - 2; i++) f.create();
    return { result: undefined };
  });
  f.task("claimed");
  const blocked = f.task("blocked");
  expect(f.area.byProject(f.projectId).tasks).toHaveLength(500);
  refuses(
    () => f.create(),
    409,
    "project has too many unfinished external tasks",
  );
  refuses(
    () =>
      f.area.reopen(f.owner.id, closed.id, { state: "done", text: "Again." }),
    409,
  );
  expect(f.create("Elsewhere", f.otherProjectId).projectId).toBe(
    f.otherProjectId,
  );
  f.area.drop(f.owner.id, blocked.id, { state: "blocked" });
  expect(
    f.area.reopen(f.owner.id, closed.id, { state: "done", text: "Again." }).task
      .task.state,
  ).toBe("open");
  f.area.drop(f.owner.id, closed.id, { state: "open" });
  expect(f.create().state).toBe("open");
  expect(f.area.byProject(f.projectId).closed).toBe(2);
});

test("bounds also guard edits and member entries without partial writes", () => {
  using f = fixture();
  const task = f.task("claimed");
  const before = f.area.show(task.id, null);
  refuses(
    () =>
      f.area.edit(task.id, {
        editRevision: 0,
        fileIds: Array.from({ length: 11 }, (_, i) => `f${i}`),
      }),
    400,
  );
  refuses(
    () =>
      f.area.answer(f.owner.id, task.id, {
        state: "claimed",
        text: "x".repeat(16 * 1024 + 1),
      }),
    400,
  );
  refuses(
    () =>
      f.area.unclaim(f.owner.id, task.id, {
        state: "claimed",
        claimId: task.claimId!,
        text: "",
      }),
    400,
  );
  expect(f.area.show(task.id, null)).toEqual(before);
});
