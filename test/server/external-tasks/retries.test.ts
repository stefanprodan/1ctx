// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { externalTasksArea } from "../../../src/server/external-tasks/index.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { STALE_TASK } from "../../../src/shared/contracts/external-task.ts";
import { fixture, HOUR, refuses } from "./fixture.ts";

test.serial(
  "claim and identical last-entry retries write and publish nothing",
  () => {
    using f = fixture();
    const task = f.create();
    const events: BusEvent[] = [];
    const stop = subscribe((event) => {
      if (event.type === "externalTask.changed") events.push(event);
    }, silent);
    try {
      const held = f.port.claim(f.key, task.id);
      f.advance(HOUR);
      expect(f.port.claim(f.key, task.id)).toEqual(held);
      expect(events).toHaveLength(1);
      expect(f.area.store.claimById(held.claimId)!.active_at).toBe(
        held.task.task.movedAt,
      );
      for (const kind of ["progress", "question"] as const) {
        const report = f.port.report(
          f.key,
          held.task.task.id,
          held.claimId,
          kind,
          kind,
          ["https://example.com/pr/1"],
        );
        const state = f.area.store.claimById(held.claimId);
        const n = events.length;
        f.advance(HOUR);
        expect(
          f.port.report(f.key, held.task.task.id, held.claimId, kind, kind, [
            "https://example.com/pr/1",
          ]),
        ).toEqual(report);
        expect(events).toHaveLength(n);
        expect(f.area.store.claimById(held.claimId)).toEqual(state);
        expect(f.port.claim(f.key, task.id).claimId).toBe(held.claimId);
      }
    } finally {
      stop();
    }
  },
);

for (const kind of ["result", "unclaim"] as const) {
  test(`${kind} retry returns its original end even after another claim or brief edit`, () => {
    using f = fixture();
    const task = f.task("claimed");
    const end = f.port.report(
      f.key,
      task.id,
      task.claimId!,
      kind,
      "Original.",
      ["https://example.com/1"],
    );
    if (kind === "result")
      f.area.reopen(f.owner.id, task.id, { state: "done", text: "Try again." });
    f.area.edit(task.id, { editRevision: 0, title: "Another attempt" });
    const next = f.area.claim(f.otherKey, task.id);
    const current = f.area.show(task.id, null);
    f.advance();
    expect(
      f.port.report(f.key, task.id, task.claimId!, kind, "Original.", [
        "https://example.com/1",
      ]),
    ).toEqual(end);
    expect(
      f.port.report(f.key, task.id, task.claimId!, kind, "Retry wording.", []),
    ).toEqual(end);
    expect(f.area.show(task.id, null)).toEqual(current);
    expect(next.claimId).not.toBe(task.claimId);
    refuses(
      () =>
        f.port.report(f.otherKey, task.id, task.claimId!, kind, "Original.", [
          "https://example.com/1",
        ]),
      409,
      STALE_TASK,
    );
    refuses(
      () =>
        f.port.report(f.key, task.id, task.claimId!, "progress", "Late.", []),
      409,
      STALE_TASK,
    );
  });
}

test("a repeated progress after a member answer is a new entry", () => {
  using f = fixture();
  const task = f.task("claimed");
  const first = f.port.report(
    f.key,
    task.id,
    task.claimId!,
    "progress",
    "Working.",
    [],
  );
  f.area.answer(f.member.id, task.id, { state: "claimed", text: "A hint." });
  const repeated = f.port.report(
    f.key,
    task.id,
    task.claimId!,
    "progress",
    "Working.",
    [],
  );
  expect(repeated.entry.id).not.toBe(first.entry.id);
  // the claim, the first progress, the answer and the repeat
  expect(repeated.task.entries).toBe(4);
  const links = f.port.report(
    f.key,
    task.id,
    task.claimId!,
    "progress",
    "Working.",
    ["http://example.com"],
  );
  expect(links.entry.id).not.toBe(first.entry.id);
  const text = f.port.report(
    f.key,
    task.id,
    task.claimId!,
    "progress",
    "Still working.",
    ["http://example.com"],
  );
  expect(text.entry.id).not.toBe(links.entry.id);
  const again = f.port.report(
    f.key,
    task.id,
    task.claimId!,
    "progress",
    "Working.",
    [],
  );
  expect(again.entry.id).not.toBe(first.entry.id);
});

test("a question repeated after an answer blocks again instead of replaying the old row", () => {
  using f = fixture();
  const task = f.task("blocked");
  const first = f.port.show(task.id, null)!.entries[0]!;
  const answered = f.area.answer(f.member.id, task.id, {
    state: "blocked",
    text: "Try the first path.",
  });
  f.advance();
  const report = f.port.report(
    f.key,
    task.id,
    task.claimId!,
    "question",
    first.text,
    first.links,
  );
  expect(report.entry.id).not.toBe(first.id);
  expect(report.task).toMatchObject({
    state: "blocked",
    entries: 4,
    revision: answered.task.task.revision + 1,
    attentionAt: f.now(),
  });
  expect(f.area.store.byId(task.id)).toEqual(report.task);
  expect(f.area.store.claimById(task.claimId!)!.active_at).toBe(f.now());
});

for (const kind of ["progress", "result", "unclaim"] as const) {
  test(`${kind} refuses a claim from another task, including a retry`, () => {
    using f = fixture();
    const task = f.task("claimed");
    const other = f.create("Other", f.otherProjectId);
    const report = () =>
      f.port.report(f.key, other.id, task.claimId!, kind, "Report.", []);
    const before = f.area.show(task.id, null);
    refuses(report, 409, STALE_TASK);
    expect(f.area.show(task.id, null)).toEqual(before);
    f.port.report(f.key, task.id, task.claimId!, kind, "Report.", []);
    const after = f.area.show(task.id, null);
    refuses(report, 409, STALE_TASK);
    expect(f.area.show(task.id, null)).toEqual(after);
    expect(f.area.store.byId(other.id)).toEqual(other);
  });
}

test("a member's unclaim of an unreported claim cannot be retried by the agent", () => {
  using f = fixture();
  const task = f.task("claimed");
  f.area.unclaim(f.owner.id, task.id, {
    state: "claimed",
    claimId: task.claimId!,
    text: "Stop.",
  });
  refuses(
    () => f.port.report(f.key, task.id, task.claimId!, "unclaim", "Stop.", []),
    409,
    STALE_TASK,
  );
});

test("a member or system unclaim does not authorize an ended progress retry", () => {
  using f = fixture();
  for (const end of ["member", "access"] as const) {
    const task = f.task("claimed");
    f.port.report(f.key, task.id, task.claimId!, "progress", "Working.", []);
    if (end === "member")
      f.area.unclaim(f.owner.id, task.id, {
        state: "claimed",
        claimId: task.claimId!,
        text: "Take a break.",
      });
    else f.area.endClaims([f.key.keyId]);
    refuses(
      () =>
        f.port.report(
          f.key,
          task.id,
          task.claimId!,
          "progress",
          "Working.",
          [],
        ),
      409,
      STALE_TASK,
    );
    refuses(
      () =>
        f.port.report(
          f.key,
          task.id,
          task.claimId!,
          "unclaim",
          "Take a break.",
          [],
        ),
      409,
      STALE_TASK,
    );
  }
});

test("a fresh area instance can retry a persisted result", () => {
  using f = fixture();
  const task = f.task("claimed");
  const ended = f.area.report(
    f.key,
    task.id,
    task.claimId!,
    "result",
    "Finished.",
    [],
  );
  f.area.reopen(f.owner.id, task.id, { state: "done", text: "New work." });
  const restarted = externalTasksArea({
    access: {
      project: (_principal, id) => ({ id }),
      reachableProjectIds: () => [f.projectId],
      visibleProjectIds: () => [f.projectId],
    },
    db: f.db,
    clock: f.now,
    externalTaskDays: () => f.limits.days,
    externalTaskIdleHours: () => f.limits.idle,
    chatOpens: () => true,
    homeProjectIds: () => [f.projectId],
    knowledge: { file: () => null, deletedName: () => null },
  });
  expect(
    restarted.report(f.key, task.id, task.claimId!, "result", "Finished.", []),
  ).toEqual(ended);
  expect(restarted.show(task.id, null)!.task.task.state).toBe("open");
});
