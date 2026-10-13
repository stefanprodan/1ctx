// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { HttpError } from "../../../src/server/lib/errors.ts";
import { silent } from "../../../src/server/lib/log.ts";
import {
  CLOSING_ENTRIES,
  MAX_CLAIMS,
  MAX_ENTRIES,
  MAX_TASK_FILES,
  MAX_UNFINISHED,
  STALE_TASK,
} from "../../../src/shared/contracts/external-task.ts";
import { fixture, refuses } from "./fixture.ts";

// the claim's limit end: 1ctx's unclaim, the task back to todo
function releasedAtLimit(
  f: ReturnType<typeof fixture>,
  taskId: string,
  claimId: string,
) {
  expect(f.area.store.claimById(claimId)!.end_reason).toBe("limit");
  const read = f.area.show(taskId, null)!;
  expect(read.task.task).toMatchObject({ state: "todo", claim: null });
  expect(read.task.task.last).toMatchObject({
    kind: "unclaim",
    by: null,
    keyName: null,
    claimEnd: "limit",
  });
  expect(read.entries[0]).toMatchObject({
    kind: "unclaim",
    by: null,
    keyName: null,
    claimId,
    claimEnd: "limit",
  });
}

test("past 240 agent entries members still move the task, the agent's next report ends its claim, and a reopen lets it claim again", () => {
  using f = fixture();
  const task = f.create();
  f.fillEntries(task.id, CLOSING_ENTRIES - 2);
  const held = f.area.claim(f.key, task.id);
  const question = f.area.report(
    f.key,
    task.id,
    held.claimId,
    "question",
    "Need help.",
    [],
  );
  expect(f.area.store.counted(task.id)).toBe(CLOSING_ENTRIES);
  expect(question.task.state).toBe("awaiting_input");
  const answered = f.area.answer(f.owner.id, task.id, {
    state: "awaiting_input",
    text: "Go.",
  });
  expect(answered.task.task.state).toBe("in_progress");
  f.area.edit(f.owner.id, task.id, { editRevision: 0, title: "Still going" });
  expect(f.area.store.counted(task.id)).toBe(CLOSING_ENTRIES);
  refuses(
    () => f.area.report(f.key, task.id, held.claimId, "progress", "More.", []),
    409,
    "make a new external task",
  );
  releasedAtLimit(f, task.id, held.claimId);
  expect(f.area.store.counted(task.id)).toBe(CLOSING_ENTRIES);
  // a retry finds its claim ended
  refuses(
    () => f.area.report(f.key, task.id, held.claimId, "progress", "More.", []),
    409,
    STALE_TASK,
  );
  // the flag says why no agent may claim it
  expect(f.area.store.byId(task.id)!.claimLimit).toBe(true);
  refuses(() => f.area.claim(f.key, task.id), 409, "make a new external task");
  const canceled = f.area.cancel(f.owner.id, task.id, { state: "todo" });
  expect(canceled.task.task.claimLimit).toBe(false);
  const reopened = f.area.reopen(f.owner.id, task.id, {
    state: "canceled",
    text: "More.",
  });
  expect(reopened.task.task).toMatchObject({
    state: "todo",
    claimLimit: false,
  });
  expect(f.area.store.counted(task.id)).toBe(0);
  expect(f.area.claim(f.key, task.id).task.task.state).toBe("in_progress");
});

test("a member reopens and answers a task whose agent entries are at the cap, and its agent is still stopped", () => {
  using f = fixture();
  const task = f.task("awaiting_input");
  f.fillEntries(task.id, MAX_ENTRIES);
  const answered = f.area.answer(f.owner.id, task.id, {
    state: "awaiting_input",
    text: "Use the first path.",
  });
  expect(answered.task.task.state).toBe("in_progress");
  refuses(
    () => f.area.report(f.key, task.id, task.claimId!, "result", "Done.", []),
    409,
    "make a new external task",
  );
  releasedAtLimit(f, task.id, task.claimId!);
  f.area.cancel(f.owner.id, task.id, { state: "todo" });
  expect(
    f.area.reopen(f.owner.id, task.id, { state: "canceled", text: "Again." })
      .task.task.state,
  ).toBe("todo");
  expect(f.area.store.counted(task.id)).toBe(0);
  expect(f.area.claim(f.key, task.id).task.task.state).toBe("in_progress");
});

test("a member unclaims a held task at the cap", () => {
  using f = fixture();
  const task = f.task("in_progress");
  f.fillEntries(task.id, MAX_ENTRIES);
  const unclaimed = f.area.unclaim(f.owner.id, task.id, {
    state: "in_progress",
    claimId: task.claimId!,
    text: "Enough.",
  });
  expect(unclaimed.task.task.state).toBe("todo");
  expect(f.area.store.claimById(task.claimId!)!.end_reason).toBe("unclaimed");
});

for (const count of [239, 240, 249, 250]) {
  for (const kind of ["result", "unclaim", "cancel"] as const) {
    test(`${kind} at ${count} agent entries`, () => {
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
      if (count === MAX_ENTRIES && kind === "result") {
        refuses(write, 409, "make a new external task");
        expect(f.area.store.counted(task.id)).toBe(count);
        releasedAtLimit(f, task.id, task.claimId!);
        return;
      }
      write();
      // a member's cancel never counts, nor is it refused
      expect(f.area.store.counted(task.id)).toBe(
        kind === "cancel" ? count : count + 1,
      );
      if (kind === "unclaim") {
        // the agent's own unclaim stops the loop, so it always lands
        expect(f.area.show(task.id, null)!.entries[0]).toMatchObject({
          kind: "unclaim",
          text: "End.",
          keyName: "laptop",
          claimEnd: "unclaimed",
        });
        expect(f.area.store.claimById(task.claimId!)!.end_reason).toBe(
          "unclaimed",
        );
      }
    });
  }
}

test("a todo task cannot take a claim at 240 agent entries until a reopen", () => {
  using f = fixture();
  const open = f.create();
  f.fillEntries(open.id, CLOSING_ENTRIES - 1);
  expect(f.area.store.byId(open.id)!.claimLimit).toBe(false);
  f.fillEntries(open.id, CLOSING_ENTRIES);
  expect(f.area.store.byId(open.id)!.claimLimit).toBe(true);
  expect(
    f.area.byProject(f.projectId).tasks.find((row) => row.id === open.id)!
      .claimLimit,
  ).toBe(true);
  refuses(() => f.area.claim(f.key, open.id), 409);
  const done = f.task("done");
  f.fillEntries(done.id, CLOSING_ENTRIES);
  expect(f.area.store.byId(done.id)!.claimLimit).toBe(false);
  expect(
    f.area.reopen(f.owner.id, done.id, { state: "done", text: "More." }).task
      .task,
  ).toMatchObject({ state: "todo", claimLimit: false });
  expect(f.area.claim(f.key, done.id).task.task.state).toBe("in_progress");
  expect(f.area.store.claimsSinceReopen(open.id)).toBe(0);
});

test("the twentieth claim since the last reopen works and retries, the twenty-first is refused until a reopen", () => {
  using f = fixture();
  const task = f.create();
  const loop = () => {
    for (let i = 0; i < MAX_CLAIMS; i++) {
      expect(f.area.store.byId(task.id)!.claimLimit).toBe(false);
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
    // the row says so while todo, on the page's detail and every list
    expect(f.area.store.byId(task.id)!.claimLimit).toBe(true);
    expect(f.area.show(task.id, null)!.task.task.claimLimit).toBe(true);
    expect(
      f.area.byProject(f.projectId).tasks.find((row) => row.id === task.id)!
        .claimLimit,
    ).toBe(true);
  };
  loop();
  expect(f.area.store.counted(task.id)).toBe(2 * MAX_CLAIMS);
  const canceled = f.area.cancel(f.owner.id, task.id, { state: "todo" });
  expect(canceled.task.task.claimLimit).toBe(false);
  const reopened = f.area.reopen(f.owner.id, task.id, {
    state: "canceled",
    text: "Again.",
  });
  expect(reopened.task.task.claimLimit).toBe(false);
  expect(f.area.store.claimsSinceReopen(task.id)).toBe(0);
  expect(f.area.store.counted(task.id)).toBe(0);
  loop();
});

test("a reopen starts the agent count again", () => {
  using f = fixture();
  const task = f.create();
  for (let round = 0; round < 3; round++) {
    const held = f.area.claim(f.key, task.id);
    f.area.report(f.key, task.id, held.claimId, "result", "Done.", []);
    expect(f.area.store.counted(task.id)).toBe(2);
    f.area.reopen(f.owner.id, task.id, { state: "done", text: "More." });
    expect(f.area.store.counted(task.id)).toBe(0);
  }
});

test.serial(
  "a release at the cap inside a caller's transaction publishes one change after its commit",
  () => {
    using f = fixture();
    const task = f.task("in_progress");
    f.fillEntries(task.id, CLOSING_ENTRIES);
    const events: BusEvent[] = [];
    const stop = subscribe((event) => {
      if (event.type === "externalTask.changed") events.push(event);
    }, silent);
    try {
      // as the tasks tool calls it: the refusal returned through the commit
      const refusal = transact(f.db, () => {
        try {
          return {
            result: f.area.report(
              f.key,
              task.id,
              task.claimId!,
              "progress",
              "Looping.",
              [],
            ),
          };
        } catch (error) {
          expect(events).toEqual([]);
          return { result: error };
        }
      });
      expect(refusal).toBeInstanceOf(HttpError);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "externalTask.changed",
        data: { task: { id: task.id, state: "todo", claim: null } },
      });
      releasedAtLimit(f, task.id, task.claimId!);
    } finally {
      stop();
    }
  },
);

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
      f.area.edit(f.owner.id, task.id, {
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
