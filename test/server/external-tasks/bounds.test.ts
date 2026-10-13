// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import {
  CLOSING_ENTRIES,
  MAX_CLAIMS,
  MAX_ENTRIES,
  MAX_TASK_FILES,
  MAX_UNFINISHED,
} from "../../../src/shared/contracts/external-task.ts";
import { fixture, refuses } from "./fixture.ts";

test("a claim taken at 238 can still end and close, its own entry counted", () => {
  using f = fixture();
  const task = f.create();
  f.fillEntries(task.id, CLOSING_ENTRIES - 2);
  const held = f.area.claim(f.key, task.id);
  const question = f.area.report(
    f.key,
    held.task.task.id,
    held.claimId,
    "question",
    "Need help.",
    [],
  );
  expect(question.task.entries).toBe(240);
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
    () =>
      f.area.answer(f.owner.id, task.id, {
        state: "awaiting_input",
        text: "Go.",
      }),
    409,
  );
  const unclaimed = f.area.unclaim(f.owner.id, task.id, {
    state: "awaiting_input",
    claimId: held.claimId,
    text: "Enough.",
  });
  expect(unclaimed.task.task.entries).toBe(241);
  refuses(() => f.area.claim(f.key, task.id), 409, "make a new external task");
  const cancelled = f.area.cancel(f.owner.id, task.id, { state: "todo" });
  expect(cancelled.task.task.entries).toBe(242);
  refuses(
    () =>
      f.area.reopen(f.owner.id, task.id, { state: "canceled", text: "More." }),
    409,
    "make a new external task",
  );
});

for (const count of [239, 240, 249, 250]) {
  for (const kind of ["result", "unclaim", "cancel"] as const) {
    test(`${kind} at ${count} entries`, () => {
      using f = fixture();
      const task = f.task("awaiting_input");
      f.fillEntries(task.id, count);
      const write = () =>
        kind === "cancel"
          ? f.area.cancel(f.owner.id, task.id, { state: "awaiting_input" }).task
              .task
          : kind === "unclaim"
            ? f.area.agentUnclaim(f.key, task.id, task.claimId!, "End.").task
            : f.area.report(f.key, task.id, task.claimId!, kind, "End.", [])
                .task;
      if (count === MAX_ENTRIES) {
        refuses(write, 409, "make a new external task");
        expect(f.area.store.counted(task.id)).toBe(count);
        expect(f.area.store.claimById(task.claimId!)!.ended_at).toBeNull();
      } else expect(write().entries).toBe(count + 1);
    });
  }
}

test("a todo task cannot take a claim at 240 entries and a closed one cannot reopen", () => {
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
  expect(f.area.store.claimsSinceReopen(open.id)).toBe(0);
});

test("the twentieth claim since the last reopen works and retries, the twenty-first is refused until a reopen", () => {
  using f = fixture();
  const task = f.create();
  const loop = () => {
    for (let i = 0; i < MAX_CLAIMS; i++) {
      const held = f.area.claim(f.key, task.id);
      expect(f.area.claim(f.key, task.id).claimId).toBe(held.claimId);
      f.area.agentUnclaim(f.key, task.id, held.claimId, "Another try.");
    }
    refuses(
      () => f.area.claim(f.key, task.id),
      409,
      "make a new external task",
    );
    expect(f.area.store.claimsSinceReopen(task.id)).toBe(MAX_CLAIMS);
  };
  loop();
  expect(f.area.store.byId(task.id)!.entries).toBe(2 * MAX_CLAIMS);
  expect(f.area.store.counted(task.id)).toBe(2 * MAX_CLAIMS);
  f.area.cancel(f.owner.id, task.id, { state: "todo" });
  f.area.reopen(f.owner.id, task.id, { state: "canceled", text: "Again." });
  expect(f.area.store.claimsSinceReopen(task.id)).toBe(0);
  loop();
});

test("a task reopened again and again stops at 250 entries", () => {
  using f = fixture();
  const task = f.create();
  let refused = false;
  while (!refused) {
    try {
      const held = f.area.claim(f.key, task.id);
      f.area.report(f.key, task.id, held.claimId, "result", "Done.", []);
      f.area.reopen(f.owner.id, task.id, { state: "done", text: "More." });
    } catch {
      refused = true;
    }
    expect(f.area.store.counted(task.id)).toBeLessThanOrEqual(MAX_ENTRIES);
  }
  const row = f.area.store.byId(task.id)!;
  expect(row.entries).toBeLessThanOrEqual(MAX_ENTRIES);
  expect(row.entries).toBeGreaterThanOrEqual(CLOSING_ENTRIES);
  refuses(() => f.area.claim(f.key, task.id), 409, "make a new external task");
});

test("500 unfinished blocks create and reopen, not history or another project", () => {
  using f = fixture();
  const closed = f.task("done");
  transact(f.db, () => {
    for (let i = 0; i < MAX_UNFINISHED - 2; i++) f.create();
    return { result: undefined };
  });
  f.task("in_progress");
  const blocked = f.task("awaiting_input");
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
  f.area.cancel(f.owner.id, blocked.id, { state: "awaiting_input" });
  expect(
    f.area.reopen(f.owner.id, closed.id, { state: "done", text: "Again." }).task
      .task.state,
  ).toBe("todo");
  f.area.cancel(f.owner.id, closed.id, { state: "todo" });
  expect(f.create().state).toBe("todo");
  expect(f.area.byProject(f.projectId).closed).toBe(2);
});

test("bounds also guard edits and member entries without partial writes", () => {
  using f = fixture();
  const task = f.task("in_progress");
  const before = f.area.show(task.id, null);
  refuses(
    () =>
      f.area.edit(task.id, {
        editRevision: 0,
        fileIds: Array.from({ length: MAX_TASK_FILES + 1 }, (_, i) => `f${i}`),
      }),
    400,
  );
  refuses(
    () =>
      f.area.answer(f.owner.id, task.id, {
        state: "in_progress",
        text: "x".repeat(16 * 1024 + 1),
      }),
    400,
  );
  refuses(
    () =>
      f.area.unclaim(f.owner.id, task.id, {
        state: "in_progress",
        claimId: task.claimId!,
        text: "",
      }),
    400,
  );
  expect(f.area.show(task.id, null)).toEqual(before);
});
