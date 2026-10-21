// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Tasks an outside agent's key makes: the key recorded, the key's cap
// of unfinished tasks, a retried create, and the key's edit and cancel
// of its own todo tasks only.

import { expect, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import {
  CLOSING_ENTRIES,
  MAX_KEY_UNFINISHED,
  MAX_UNFINISHED,
  STALE_TASK,
} from "../../../src/shared/contracts/external-task.ts";
import { MAX_TITLE } from "../../../src/shared/words.ts";
import { fixture, refuses } from "./fixture.ts";

const CAP = `this key has ${MAX_KEY_UNFINISHED} unfinished tasks it created; cancel one or wait for a member to finish one`;
const NOT_OWN = "only this key's tasks in todo can be changed over MCP";

const brief = (title: string) => ({
  title,
  labels: ["build"],
  fileIds: ["brief"],
});

test("a key's task records the key's user, id and name and writes no entry", () => {
  using f = fixture();
  const made = f.area.agentCreate(f.key, f.projectId, brief("  Follow up  "));
  expect(made.task.task).toMatchObject({
    title: "Follow up",
    state: "todo",
    entries: 0,
    createdBy: { id: f.owner.id, username: "owner" },
  });
  expect(made.task.createdKeyName).toBe("laptop");
  expect(made.createdKeyId).toBe("key");
  expect(made.entries).toEqual([]);
  expect(
    f.db
      .query("select created_key_id, created_key_name from external_tasks")
      .get(),
  ).toEqual({ created_key_id: "key", created_key_name: "laptop" });
  // a todo task waits on an agent, never on Home
  expect(f.area.waiting([f.projectId]).count).toBe(0);
  // the page's and a chat's tasks name no key
  expect(f.area.show(f.create().id, null)!).toMatchObject({
    task: { createdKeyName: null },
    createdKeyId: null,
  });
});

test("a retried create answers the key's unfinished task of that title", () => {
  using f = fixture();
  const first = f.area.agentCreate(f.key, f.projectId, brief("Follow up"));
  const again = f.area.agentCreate(f.key, f.projectId, brief(" Follow up"));
  expect(again.task.task.id).toBe(first.task.task.id);
  const other = f.area.agentCreate(f.otherKey, f.projectId, brief("Follow up"));
  expect(other.task.task.id).not.toBe(first.task.task.id);
  expect(f.area.store.keyUnfinishedCount("key")).toBe(1);
  // once it is closed, the title makes a new task
  f.area.cancel(f.owner.id, first.task.task.id, { state: "todo" });
  const next = f.area.agentCreate(f.key, f.projectId, brief("Follow up"));
  expect(next.task.task.id).not.toBe(first.task.task.id);
});

test("the brief checks and the project's bound hold for a key's create", () => {
  using f = fixture();
  refuses(
    () => f.area.agentCreate(f.key, f.projectId, brief(" ")),
    400,
    `title must be one line of 1 to ${MAX_TITLE} characters`,
  );
  refuses(
    () =>
      f.area.agentCreate(f.key, f.projectId, {
        ...brief("Follow up"),
        labels: ["nope"],
      }),
    400,
    "labels must name this project's labels",
  );
  refuses(
    () =>
      f.area.agentCreate(f.key, f.projectId, {
        ...brief("Follow up"),
        fileIds: ["missing"],
      }),
    400,
    "no such knowledge file",
  );
  transact(f.db, () => {
    for (let i = 0; i < MAX_UNFINISHED; i++) f.create();
    return { result: undefined };
  });
  refuses(
    () => f.area.agentCreate(f.key, f.projectId, brief("Follow up")),
    409,
    "project has too many unfinished external tasks",
  );
  expect(f.area.store.keyUnfinishedCount("key")).toBe(0);
});

test("a key holds at most its cap of unfinished tasks across projects", () => {
  using f = fixture();
  // the page's and a chat's tasks never count
  f.create();
  f.area.create(f.owner.id, f.projectId, brief("From a chat"), "chat");
  const made = Array.from({ length: MAX_KEY_UNFINISHED }, (_, i) =>
    f.area.agentCreate(
      f.key,
      i % 2 === 0 ? f.projectId : f.otherProjectId,
      brief(`Part ${i}`),
    ),
  ).map((read) => read.task.task.id);
  refuses(
    () => f.area.agentCreate(f.key, f.projectId, brief("One more")),
    409,
    CAP,
  );
  // another key still creates
  f.area.agentCreate(f.otherKey, f.projectId, brief("One more"));
  // a member's cancel makes room
  f.area.cancel(f.owner.id, made[0]!, { state: "todo" });
  f.area.agentCreate(f.key, f.projectId, brief("One more"));
  refuses(
    () => f.area.agentCreate(f.key, f.projectId, brief("Two more")),
    409,
    CAP,
  );
  // so does finishing one
  const claimId = f.area.claim(f.otherKey, made[2]!).claimId;
  f.area.report(f.otherKey, made[2]!, claimId, "result", "Done.", []);
  f.area.agentCreate(f.key, f.projectId, brief("Two more"));
  // and the key's own cancel
  refuses(
    () => f.area.agentCreate(f.key, f.projectId, brief("Three more")),
    409,
    CAP,
  );
  f.area.agentCancel(f.key, made[4]!);
  f.area.agentCreate(f.key, f.projectId, brief("Three more"));
});

test("a key edits and cancels its own todo task, the entries carrying its name", () => {
  using f = fixture();
  const id = f.area.agentCreate(f.key, f.projectId, brief("Follow up")).task
    .task.id;
  const edited = f.area.agentEdit(f.key, id, {
    editRevision: 0,
    title: "Follow up, sharper",
  });
  expect(edited.task.task.title).toBe("Follow up, sharper");
  expect(edited.entries[0]).toMatchObject({
    kind: "edit",
    by: { id: f.owner.id },
    keyName: "laptop",
    claimId: null,
  });
  expect(f.area.store.counted(id)).toBe(1);
  refuses(
    () => f.area.agentEdit(f.key, id, { editRevision: 0, title: "Stale" }),
    409,
    STALE_TASK,
  );
  const canceled = f.area.agentCancel(f.key, id);
  expect(canceled.task.task).toMatchObject({
    state: "canceled",
    last: { kind: "cancel", keyName: "laptop", by: { id: f.owner.id } },
  });
  expect(canceled.entries[0]).toMatchObject({
    kind: "cancel",
    keyName: "laptop",
    claimId: null,
    claimEnd: null,
  });
});

test("a key's edit and cancel reach no other task", () => {
  using f = fixture();
  const member = f.create("A member's");
  const another = f.area.agentCreate(f.otherKey, f.projectId, brief("Theirs"))
    .task.task.id;
  const claimed = f.area.agentCreate(f.key, f.projectId, brief("Claimed")).task
    .task.id;
  f.area.claim(f.otherKey, claimed);
  const done = f.area.agentCreate(f.key, f.projectId, brief("Done")).task.task
    .id;
  const claimId = f.area.claim(f.key, done).claimId;
  f.area.report(f.key, done, claimId, "result", "Finished.", []);
  for (const id of [member.id, another, claimed, done]) {
    const before = f.area.store.byId(id)!;
    refuses(
      () =>
        f.area.agentEdit(f.key, id, {
          editRevision: before.editRevision,
          title: "Mine now",
        }),
      409,
      NOT_OWN,
    );
    refuses(() => f.area.agentCancel(f.key, id), 409, NOT_OWN);
    expect(f.area.store.byId(id)).toEqual(before);
  }
});

test("a key's edit is refused from the closing entries, its cancel still lands", () => {
  using f = fixture();
  const id = f.area.agentCreate(f.key, f.projectId, brief("Loop")).task.task.id;
  f.fillEntries(id, CLOSING_ENTRIES - 1);
  f.area.agentEdit(f.key, id, { editRevision: 0, title: "Loop again" });
  expect(f.area.store.counted(id)).toBe(CLOSING_ENTRIES);
  refuses(
    () => f.area.agentEdit(f.key, id, { editRevision: 1, title: "And again" }),
    409,
    "make a new external task",
  );
  // a member's edit is never refused by a bound
  f.area.edit(f.owner.id, id, { editRevision: 1, title: "A member's" });
  expect(f.area.agentCancel(f.key, id).task.task.state).toBe("canceled");
});
