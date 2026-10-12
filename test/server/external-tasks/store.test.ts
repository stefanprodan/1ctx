// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { STALE_TASK } from "../../../src/shared/contracts/external-task.ts";
import {
  AGENT_ENTRY_KINDS,
  EXTERNAL_TASK_STATES,
  type ExternalTaskState,
} from "../../../src/shared/words.ts";
import { fixture, refuses } from "./fixture.ts";

describe("external task writes", () => {
  const agentStates = {
    progress: { claimed: "claimed", blocked: "claimed" },
    question: { claimed: "blocked" },
    result: { claimed: "done", blocked: "done" },
    unclaim: { claimed: "open", blocked: "open" },
  };
  for (const state of EXTERNAL_TASK_STATES) {
    for (const kind of AGENT_ENTRY_KINDS) {
      test(`agent ${kind} while ${state}`, () => {
        using f = fixture();
        const task = f.task(state);
        f.advance();
        const expected = (
          agentStates[kind] as Partial<Record<typeof state, ExternalTaskState>>
        )[state];
        const write = () =>
          f.area.report(
            f.key,
            task.id,
            task.claimId ?? "missing",
            kind,
            "Report.",
            [],
          );
        if (state === "done" && kind === "result") {
          expect(write().task).toEqual(f.area.store.byId(task.id)!);
          expect(f.area.store.byId(task.id)!.entries).toBe(task.entries);
        } else if (expected === undefined) {
          refuses(write, task.claimId === null ? 404 : 409);
        } else {
          const result = write();
          expect(result.task.state).toBe(expected);
          expect(result.task.revision).toBe(task.revision + 1);
          expect(result.task.editRevision).toBe(task.editRevision);
          expect(result.task.movedAt).toBe(
            expected === state ? task.movedAt : f.now(),
          );
          expect(result.entry).toMatchObject({
            by: { id: f.owner.id, username: "owner" },
            keyName: "laptop",
            claimId: task.claimId,
          });
        }
      });
    }
  }
  const memberStates = {
    answer: { claimed: "claimed", blocked: "claimed" },
    unclaim: { claimed: "open", blocked: "open" },
    cancel: { open: "cancelled", claimed: "cancelled", blocked: "cancelled" },
    reopen: { done: "open", cancelled: "open" },
  };
  for (const state of EXTERNAL_TASK_STATES) {
    for (const kind of ["answer", "unclaim", "cancel", "reopen"] as const) {
      test(`member ${kind} while ${state}`, () => {
        using f = fixture();
        const task = f.task(state);
        f.advance();
        const expected = (
          memberStates[kind] as Partial<Record<typeof state, ExternalTaskState>>
        )[state];
        const write = () =>
          f.area[kind](f.member.id, task.id, {
            state,
            text: "Member note.",
            claimId: task.claimId ?? undefined,
          });
        if (expected === undefined) refuses(write, 409);
        else {
          const result = write();
          expect(result.task.task.state).toBe(expected);
          expect(result.entries[0]).toMatchObject({
            kind,
            by: { id: f.member.id, username: "member" },
            keyName: null,
            claimId:
              kind === "unclaim" || kind === "cancel"
                ? (task.claim?.id ?? null)
                : null,
          });
          expect(result.task.task.revision).toBe(task.revision + 1);
          expect(result.task.task.movedAt).toBe(
            expected === state ? task.movedAt : f.now(),
          );
        }
      });
    }
  }

  test.serial(
    "a claim writes its own entry in its transaction, outside the bound and the mark",
    () => {
      using f = fixture();
      const events: BusEvent[] = [];
      const stop = subscribe((event) => {
        if (event.type === "externalTask.changed") events.push(event);
      }, silent);
      try {
        const task = f.task("claimed");
        f.area.report(f.key, task.id, task.claimId!, "unclaim", "Later.", []);
        const marked = f.area.store.byId(task.id)!;
        expect(marked.attentionAt).not.toBeNull();
        expect(() =>
          transact(f.db, () => {
            f.area.claim(f.key, task.id);
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        expect(f.area.store.byId(task.id)).toEqual(marked);
        f.advance();
        events.length = 0;
        const held = f.area.claim(f.key, task.id);
        const entry = held.entries[0]!;
        expect(entry).toEqual({
          id: entry.id,
          kind: "claim",
          text: "",
          links: [],
          by: { id: f.owner.id, username: "owner" },
          keyName: "laptop",
          claimId: held.claimId,
          claimEnd: null,
          at: f.now(),
        });
        expect(held.task.task).toMatchObject({
          entries: marked.entries + 1,
          last: marked.last,
          attentionAt: marked.attentionAt,
          revision: marked.revision + 1,
        });
        expect(f.area.store.counted(task.id)).toBe(marked.entries - 1);
        expect(events).toEqual([
          {
            type: "externalTask.changed",
            data: { projectId: f.projectId, task: held.task.task },
          },
        ]);
        // a retry answers the same claim and writes nothing
        expect(f.area.claim(f.key, task.id).claimId).toBe(held.claimId);
        expect(f.area.store.byId(task.id)!.entries).toBe(marked.entries + 1);
        expect(f.area.store.lastEntry(held.claimId, true)!.id).toBe(entry.id);
      } finally {
        stop();
      }
    },
  );

  test("claim contenders keep one holder and never name the other user", () => {
    using f = fixture();
    const task = f.create();
    const held = f.port.claim(f.key, task.id);
    refuses(
      () => f.port.claim(f.otherKey, task.id),
      409,
      "this task is already claimed",
    );
    refuses(
      () =>
        f.port.report(
          f.otherKey,
          held.task.task.id,
          held.claimId,
          "result",
          "Late.",
          [],
        ),
      409,
      STALE_TASK,
    );
    expect(f.area.store.claimsCount(task.id)).toBe(1);
    expect(f.area.store.byId(task.id)!.claim?.userId).toBe(f.owner.id);
  });

  test("stale member states and unclaim claim ids write nothing", () => {
    using f = fixture();
    const task = f.task("claimed");
    for (const kind of ["answer", "unclaim", "cancel", "reopen"] as const) {
      refuses(
        () =>
          f.area[kind](f.owner.id, task.id, {
            state: "open",
            text: "Outdated.",
            claimId: task.claimId!,
          }),
        409,
        STALE_TASK,
      );
    }
    f.area.unclaim(f.member.id, task.id, {
      state: "claimed",
      claimId: task.claimId!,
      text: "Start again.",
    });
    const next = f.area.claim(f.otherKey, task.id);
    const before = f.area.show(task.id, null);
    refuses(
      () =>
        f.area.unclaim(f.owner.id, task.id, {
          state: "claimed",
          claimId: task.claimId!,
          text: "Late unclaim.",
        }),
      409,
      STALE_TASK,
    );
    refuses(
      () =>
        f.area.report(
          f.key,
          task.id,
          task.claimId!,
          "result",
          "Late result.",
          [],
        ),
      409,
      STALE_TASK,
    );
    expect(f.area.show(task.id, null)).toEqual(before);
    expect(next.claimId).not.toBe(task.claimId);
  });

  for (const state of EXTERNAL_TASK_STATES) {
    test(`brief edit while ${state}`, () => {
      using f = fixture();
      const task = f.task(state);
      const run = () =>
        f.area.edit(task.id, {
          editRevision: task.editRevision,
          text: "New brief.",
        });
      if (state === "done" || state === "cancelled") {
        refuses(run, 409, `this task is ${state}`);
        return;
      }
      f.advance();
      const updated = run();
      expect(updated.task).toMatchObject({
        text: "New brief.",
        briefAt: f.now(),
      });
      expect(updated.task.task).toMatchObject({
        revision: task.revision + 1,
        editRevision: task.editRevision + 1,
        claim: task.claim,
        entries: task.entries,
        movedAt: task.movedAt,
      });
      refuses(run, 409, STALE_TASK);
    });
  }

  test("reports, answers and seen move only revision, so a held brief edit still saves", () => {
    using f = fixture();
    const task = f.task("claimed");
    f.area.report(
      f.key,
      task.id,
      task.claimId!,
      "question",
      "Need a choice.",
      [],
    );
    const marked = f.area.show(task.id, null)!;
    expect(marked.task.task.attentionAt).toBe(f.now());
    expect(f.area.show(task.id, null)).toEqual(marked);
    const continued = f.area.report(
      f.key,
      task.id,
      task.claimId!,
      "progress",
      "Found a way.",
      [],
    );
    expect(continued.task.attentionAt).toBe(marked.task.task.attentionAt);
    const answered = f.area.answer(f.owner.id, task.id, {
      state: "claimed",
      text: "Agreed.",
    });
    expect(answered.task.task.state).toBe("claimed");
    expect(answered.task.task.revision).toBe(continued.task.revision + 1);
    const body = { attentionAt: marked.task.task.attentionAt! };
    const seen = f.area.seen(task.id, body);
    expect(answered.task.task.attentionAt).toBeNull();
    expect(seen.task.task.revision).toBe(answered.task.task.revision);
    expect(seen.task.task.attentionAt).toBeNull();
    expect(f.area.seen(task.id, body)).toEqual(seen);
    expect(seen.task.task.editRevision).toBe(task.editRevision);
    const edited = f.area.edit(task.id, {
      editRevision: task.editRevision,
      title: "Updated",
    });

    expect(edited.task.task.editRevision).toBe(task.editRevision + 1);
    expect(
      f.area.edit(task.id, { editRevision: edited.task.task.editRevision }),
    ).toEqual(edited);
  });

  test("seen leaves a newer attention mark and its revision unchanged", () => {
    using f = fixture();
    const task = f.task("blocked");
    f.advance();
    f.area.report(f.key, task.id, task.claimId!, "result", "Finished.", []);
    const before = f.area.show(task.id, null)!;
    expect(f.area.seen(task.id, { attentionAt: task.attentionAt! })).toEqual(
      before,
    );
    expect(f.area.show(task.id, null)).toEqual(before);
  });

  test("create and edit store trimmed titles and a whitespace-only edit is a no-op", () => {
    using f = fixture();
    const task = f.create("  Do the work \t");
    expect(task.title).toBe("Do the work");
    const edited = f.area.edit(task.id, {
      editRevision: 0,
      title: "  New title  ",
    });
    expect(edited.task.task.title).toBe("New title");
    expect(
      f.area.edit(task.id, { editRevision: 1, title: " New title " }),
    ).toEqual(edited);
    expect(
      f.db
        .query<{ title: string }, [string]>(
          "select title from external_tasks where id = ?",
        )
        .get(task.id)!.title,
    ).toBe("New title");
  });

  for (const kind of ["answer", "unclaim", "cancel", "reopen"] as const) {
    test(`member ${kind} clears attention`, () => {
      using f = fixture();
      const task = f.task(kind === "reopen" ? "done" : "blocked");
      expect(task.attentionAt).not.toBeNull();
      f.advance();
      const result = f.area[kind](f.member.id, task.id, {
        state: task.state,
        claimId: task.claimId!,
        text: "Member acted.",
      });
      expect(result.task.task.attentionAt).toBeNull();
      expect(result.task.task.revision).toBe(task.revision + 1);
      expect(f.area.attention([f.projectId])).toEqual({ tasks: [], count: 0 });
    });
  }

  test.serial(
    "events wait for the outer commit and disappear on rollback",
    () => {
      using f = fixture();
      const events: BusEvent[] = [];
      const stop = subscribe((event) => {
        if (
          event.type === "externalTask.changed" ||
          event.type === "externalTask.deleted"
        )
          events.push(event);
      }, silent);
      try {
        const task = transact(f.db, () => {
          const row = f.create();
          expect(events).toEqual([]);
          return { result: row };
        });
        expect(events).toEqual([
          {
            type: "externalTask.changed",
            data: { projectId: f.projectId, task },
          },
        ]);
        events.length = 0;
        expect(() =>
          transact(f.db, () => {
            f.area.claim(f.key, task.id);
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        expect(events).toEqual([]);
        expect(f.area.store.byId(task.id)).toEqual(task);
        expect(f.area.store.claimsCount(task.id)).toBe(0);
        const held = f.area.claim(f.key, task.id);
        f.area.report(
          f.key,
          held.task.task.id,
          held.claimId,
          "progress",
          "Working.",
          [],
        );
        f.area.answer(f.owner.id, task.id, {
          state: "claimed",
          text: "A hint.",
        });
        expect(events.map((event) => event.type)).toEqual(
          Array(3).fill("externalTask.changed"),
        );
        f.area.delete(task.id);
        expect(events.at(-1)).toEqual({
          type: "externalTask.deleted",
          data: { projectId: f.projectId, taskId: task.id },
        });
      } finally {
        stop();
      }
    },
  );
});
