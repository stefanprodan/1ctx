// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home's External tasks card: drawn only while a task awaits input, a row
// per task naming its project, the question it waits on and its labels,
// the first few with Show more for the rest.

import { afterEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { projects } from "../../../src/client/data/projects.ts";
import { waitingTasks } from "../../../src/client/data/waiting-tasks.ts";
import { WaitingTasks } from "../../../src/client/views/home/WaitingTasks.tsx";
import type { ExternalTaskRow } from "../../../src/shared/contracts/external-task.ts";

const row: ExternalTaskRow = {
  id: "t1",
  projectId: "p1",
  title: "Wire the sweep",
  labels: ["build"],
  state: "awaiting_input",
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
  last: {
    kind: "question",
    text: "Which branch?",
    at: 5,
    by: { id: "u1", username: "stefan" },
    keyName: "laptop-claude",
    claimEnd: null,
  },
  entries: 2,
  createdBy: null,
  createdAt: 1,
  movedAt: 5,
};

afterEach(() => {
  waitingTasks.value = null;
  projects.value = null;
});

describe("Home's External tasks card", () => {
  test.serial("draws nothing while no task awaits input", () => {
    waitingTasks.value = { tasks: [], count: 0 };
    expect(render(<WaitingTasks now={10} />)).toBe("");
  });

  test.serial("lists each waiting task with its question and labels", () => {
    projects.value = [
      { id: "p1", kind: "team", name: "infra", createdAt: 0, memberCount: 2 },
    ];
    waitingTasks.value = { tasks: [row], count: 1 };
    const html = render(<WaitingTasks now={10} />);
    expect(html).toContain("External tasks");
    expect(html).toContain('href="/external-tasks/t1"');
    expect(html).toContain("#infra · Which branch?");
    expect(html).toContain('<span class="tag external-tasks-tag">build</span>');
    expect(html).toContain("external-tasks-ring status-attention");
  });

  test.serial("opens on the first rows and offers more", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      ...row,
      id: `t${i}`,
    }));
    waitingTasks.value = { tasks: rows, count: 100 };
    const html = render(<WaitingTasks now={10} />);
    expect(html.match(/href="\/external-tasks\/t\d"/g)).toHaveLength(5);
    expect(html).toContain("Show more");
    expect(html).toContain(">100<");
  });

  test.serial("offers no more when every row fits", () => {
    waitingTasks.value = { tasks: [row], count: 1 };
    expect(render(<WaitingTasks now={10} />)).not.toContain("Show more");
  });
});
