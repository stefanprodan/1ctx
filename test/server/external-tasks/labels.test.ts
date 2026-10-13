// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import type { AgentEntryKind } from "../../../src/shared/words.ts";
import { fixture, refuses } from "./fixture.ts";

const labelId = (f: ReturnType<typeof fixture>, name: string) =>
  f.db
    .query<{ id: string }, [string, string]>(
      "select id from project_labels where project_id = ? and name = ?",
    )
    .get(f.projectId, name)!.id;

test("a task stores its labels shaped, in order, and reads their names now", () => {
  using f = fixture();
  const task = f.area.create(f.owner.id, f.projectId, {
    title: "Sort it",
    labels: [" Fix", "BUILD "],
    fileIds: ["brief"],
  }).task.task;
  expect(task.labels).toEqual(["fix", "build"]);
  f.db
    .query("update project_labels set name = 'bug' where id = ?")
    .run(labelId(f, "fix"));
  expect(f.area.store.byId(task.id)!.labels).toEqual(["bug", "build"]);
  expect(f.area.byProject(f.projectId).tasks[0]!.labels).toEqual([
    "bug",
    "build",
  ]);
  // another project's label is not this one's, whatever its name
  refuses(
    () =>
      f.area.create(f.owner.id, f.otherProjectId, {
        title: "Elsewhere",
        labels: ["bug"],
        fileIds: ["brief"],
      }),
    400,
    "labels must name this project's labels",
  );
});

test("a label edit moves the edit revision, and a task whose labels went takes one at its next edit", () => {
  using f = fixture();
  const task = f.create();
  const relabeled = f.area.edit(task.id, {
    editRevision: 0,
    labels: ["plan", "build"],
  }).task.task;
  expect(relabeled).toMatchObject({
    labels: ["plan", "build"],
    editRevision: 1,
    revision: task.revision + 1,
  });
  // the same labels again change nothing
  expect(
    f.area.edit(task.id, { editRevision: 1, labels: ["plan", "build"] }).task
      .task.editRevision,
  ).toBe(1);
  refuses(
    () => f.area.edit(task.id, { editRevision: 0, labels: ["fix"] }),
    409,
  );
  for (const name of ["plan", "build"]) {
    f.db.query("delete from project_labels where id = ?").run(labelId(f, name));
  }
  const bare = f.area.store.byId(task.id)!;
  expect(bare.labels).toEqual([]);
  expect(bare.revision).toBe(relabeled.revision);
  refuses(
    () => f.area.edit(task.id, { editRevision: 1, title: "Renamed" }),
    400,
  );
  expect(
    f.area.edit(task.id, { editRevision: 1, title: "Renamed", labels: ["fix"] })
      .task.task.labels,
  ).toEqual(["fix"]);
});

test("label counts name every label of the project with its unfinished tasks", () => {
  using f = fixture();
  const make = (labels: string[]) =>
    f.area.create(f.owner.id, f.projectId, {
      title: "Work",
      labels,
      fileIds: ["brief"],
    }).task.task;
  make(["build", "fix"]);
  const claimed = make(["build"]);
  f.area.claim(f.key, claimed.id);
  const closed = make(["fix", "research"]);
  f.area.cancel(f.owner.id, closed.id, { state: "todo" });
  f.area.create(f.member.id, f.otherProjectId, {
    title: "Other",
    labels: ["plan"],
    fileIds: ["brief"],
  });
  expect(f.area.openLabelCounts(f.projectId)).toEqual([
    { name: "build", open: 2 },
    { name: "fix", open: 1 },
    { name: "plan", open: 0 },
    { name: "research", open: 0 },
  ]);
  // the detail's counts take closed tasks too, by label id
  expect(f.area.labelTasks(f.projectId)).toEqual(
    new Map([
      [labelId(f, "build"), 2],
      [labelId(f, "fix"), 2],
      [labelId(f, "research"), 1],
    ]),
  );
});

test("report never gives a task back: unclaim is its own action", () => {
  using f = fixture();
  const task = f.task("in_progress");
  refuses(
    () =>
      f.area.report(
        f.key,
        task.id,
        task.claimId!,
        "unclaim" as AgentEntryKind,
        "Later.",
        [],
      ),
    400,
    "kind must be one of progress, question, result",
  );
  // an agent's and a chat tool's reads keep plain text, the page renders
  expect(
    f.area.show(task.id, null)!.entries.some((entry) => "html" in entry),
  ).toBe(false);
  expect(f.area.store.byId(task.id)!.state).toBe("in_progress");
  const back = f.area.agentUnclaim(f.key, task.id, task.claimId!, "Later.");
  expect(back.task.state).toBe("todo");
  expect(back.entry).toMatchObject({
    kind: "unclaim",
    claimEnd: "unclaimed",
    keyName: "laptop",
  });
  // a retry answers the first
  expect(f.area.agentUnclaim(f.key, task.id, task.claimId!, "Again.")).toEqual(
    back,
  );
});

test("a list filter matches any label by its shaped name, and held ignores it", () => {
  using f = fixture();
  const make = (labels: string[]) =>
    f.area.create(f.owner.id, f.projectId, {
      title: "Work",
      labels,
      fileIds: ["brief"],
    }).task.task.id;
  const build = make(["build"]);
  const fix = make(["fix"]);
  make(["plan"]);
  const list = (labels: string[], held = false) =>
    f.area
      .list({
        projectIds: [f.projectId],
        states: ["todo", "in_progress"],
        labels,
        held: held ? f.key : null,
        after: null,
        limit: 50,
      })
      .rows.map((row) => row.id)
      .sort();
  expect(list([" Build"])).toEqual([build]);
  expect(list(["BUILD ", "fix"])).toEqual([build, fix].sort());
  expect(list(["nothing"])).toEqual([]);
  f.area.claim(f.key, fix);
  expect(list(["build"], true)).toEqual([fix]);
});
