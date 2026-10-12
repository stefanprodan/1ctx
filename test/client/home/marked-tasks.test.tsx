// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home's External tasks card: drawn only while a task is marked, a row
// per task naming its project, who holds the claim and its last entry,
// the first few with Show more for the rest.

import { afterEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { markedTasks } from "../../../src/client/data/marked-tasks.ts";
import { MarkedTasks } from "../../../src/client/views/home/MarkedTasks.tsx";
import type { ExternalTaskRow } from "../../../src/shared/contracts/external-task.ts";

const row: ExternalTaskRow = {
  id: "t1",
  projectId: "p1",
  title: "Wire the sweep",
  scope: "Scope B",
  state: "blocked",
  revision: 3,
  editRevision: 0,
  claim: {
    id: "c1",
    userId: "u1",
    username: "stefan",
    keyId: "k1",
    keyName: "laptop-claude",
    startedAt: 1,
    activeAt: 1,
  },
  last: { kind: "question", text: "Which branch?", at: 5 },
  entries: 2,
  attentionAt: 5,
  createdBy: null,
  createdAt: 1,
  movedAt: 5,
};

afterEach(() => {
  markedTasks.value = null;
});

describe("Home's External tasks card", () => {
  test.serial("draws nothing while no task is marked", () => {
    markedTasks.value = { tasks: [], count: 0 };
    expect(render(<MarkedTasks now={10} />)).toBe("");
  });

  test.serial("lists each marked task with its claim and last entry", () => {
    markedTasks.value = { tasks: [row], count: 1 };
    const html = render(<MarkedTasks now={10} />);
    expect(html).toContain("External tasks");
    expect(html).toContain('href="/external-tasks/t1"');
    expect(html).toContain("Scope B");
    expect(html).toContain("blocked · claimed by stefan via laptop-claude");
    expect(html).toContain("Question: Which branch?");
  });

  test.serial("opens on the first rows and offers more", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      ...row,
      id: `t${i}`,
    }));
    markedTasks.value = { tasks: rows, count: 100 };
    const html = render(<MarkedTasks now={10} />);
    expect(html.match(/href="\/external-tasks\/t\d"/g)).toHaveLength(5);
    expect(html).toContain("Show more");
    expect(html).toContain(">100<");
  });

  test.serial("offers no more when every row fits", () => {
    markedTasks.value = { tasks: [row], count: 1 };
    expect(render(<MarkedTasks now={10} />)).not.toContain("Show more");
  });
});
