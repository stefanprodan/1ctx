// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The External tasks tab: the notice linking Connect agents, the current
// tasks searched on the page with a count, and the done and cancelled
// ones searched and filtered by the server, with no count, hidden while
// there are none.

import { afterEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  closedCount,
  closedFilter,
  closedPages,
  externalTasks,
} from "../../../src/client/data/external-tasks.ts";
import { ALL_CLOSED } from "../../../src/client/data/external-tasks-rows.ts";
import {
  CurrentTasks,
  FinishedTasks,
  TasksIntro,
} from "../../../src/client/views/projects/ExternalTasks.tsx";
import type { ExternalTaskRow } from "../../../src/shared/contracts/external-task.ts";

const row = (changes: Partial<ExternalTaskRow> = {}): ExternalTaskRow => ({
  id: "t1",
  projectId: "p1",
  title: "Wire the sweep",
  labels: [],
  state: "todo",
  revision: 1,
  editRevision: 0,
  claim: null,
  last: null,
  entries: 0,
  createdBy: { id: "u1", username: "stefan" },
  createdAt: 1_000,
  movedAt: 1_000,
  ...changes,
});

afterEach(() => {
  externalTasks.value = null;
  closedCount.value = 0;
  closedFilter.value = ALL_CLOSED;
  closedPages.value = null;
});

describe("the notice", () => {
  test("says what the tasks are and links Connect agents in place", () => {
    const html = render(<TasksIntro />);
    expect(html).toContain('class="page-notice"');
    expect(html).toContain("Work for an agent you run outside 1ctx.");
    expect(html).toContain('<a class="btn btn-small" href="/connect">');
    expect(html).toContain(">Connect agents</a>");
    expect(html).not.toContain("target=");
  });
});

describe("the current tasks", () => {
  test.serial("a search box and the count beside New external task", () => {
    externalTasks.value = [row(), row({ id: "t2", state: "awaiting_input" })];
    const html = render(<CurrentTasks projectId="p1" now={2_000} />);
    expect(html).toContain('placeholder="Search current tasks"');
    expect(html).toContain('<span class="rows-count" aria-live="polite">2<');
    expect(html).toContain("New external task");
  });

  test.serial("a project with none says so, with no count", () => {
    externalTasks.value = [];
    const html = render(<CurrentTasks projectId="p1" now={2_000} />);
    expect(html).toContain("No external tasks yet.");
    expect(html).not.toContain("rows-count");
  });
});

describe("the done and canceled tasks", () => {
  test.serial("hidden while the project has none and nothing is set", () => {
    closedPages.value = { rows: [], next: null };
    expect(render(<FinishedTasks now={2_000} />)).toBe("");
  });

  test.serial("a search and All, Done, Canceled, with no count", () => {
    closedCount.value = 1;
    closedPages.value = {
      rows: [row({ id: "d1", state: "done" })],
      next: "5.abcdefghijkl",
    };
    const html = render(<FinishedTasks now={2_000} />);
    expect(html).toContain('placeholder="Search finished tasks"');
    expect(html).not.toContain("rows-count");
    for (const label of ["All", "Done", "Canceled"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toContain('aria-pressed="true">All<');
    expect(html).toContain('href="/external-tasks/d1"');
    expect(html).toContain("Show more");
  });

  test.serial("a filter with no match says so", () => {
    closedFilter.value = { q: "", state: "canceled" };
    closedPages.value = { rows: [], next: null };
    const html = render(<FinishedTasks now={2_000} />);
    expect(html).toContain("No external task matches.");
    expect(html).toContain('aria-pressed="true">Canceled<');
  });
});
