// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The External tasks tab: the notice linking Connect agents, then one
// card with a search, Open, Done and Canceled, and New task. Open groups
// the unfinished tasks by whose turn it is, twenty rows a group; Done and
// Canceled draw the server's pages. A row is the feed's two lines, its
// labels as tags.

import { afterEach, describe, expect, test } from "bun:test";
import type { VNode } from "preact";
import { render } from "preact-render-to-string";
import { path, query } from "../../../src/client/app/router.ts";
import {
  closedCount,
  closedFilter,
  closedPages,
  externalTasks,
} from "../../../src/client/data/external-tasks.ts";
import { ALL_CLOSED } from "../../../src/client/data/external-tasks-rows.ts";
import type { TasksShow } from "../../../src/client/lib/hrefs.ts";
import { TaskRow } from "../../../src/client/views/projects/ExternalTaskRow.tsx";
import {
  TasksCard,
  TasksIntro,
} from "../../../src/client/views/projects/ExternalTasks.tsx";
import type { ExternalTaskRow } from "../../../src/shared/contracts/external-task.ts";

const row = (changes: Partial<ExternalTaskRow> = {}): ExternalTaskRow => ({
  id: "t1",
  projectId: "p1",
  title: "Wire the sweep",
  labels: ["build"],
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

const card = (show: TasksShow | null = null, q = "") =>
  render(<TasksCard projectId="p1" show={show} q={q} now={2_000} />);

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

describe("the card", () => {
  test.serial("a search, Open, Done, Canceled and New task, no count", () => {
    externalTasks.value = [row()];
    const html = card();
    expect(html).toContain('placeholder="Search tasks"');
    for (const label of ["Open", "Done", "Canceled"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toContain('aria-pressed="true">Open<');
    // on a phone the switch is a dropdown and New task its plus alone
    expect(html).toContain('class="rows-filters-pick"');
    expect(html).toContain('aria-label="New task"');
    expect(html).toContain('<span class="rows-add-words">New task</span>');
    expect(html).not.toContain("rows-count");
  });

  test.serial("groups by whose turn it is, each with its count", () => {
    externalTasks.value = [
      row({ id: "a", state: "awaiting_input" }),
      row({ id: "b", state: "in_progress" }),
      row({ id: "c" }),
      row({ id: "d" }),
    ];
    const html = card();
    const at = (words: string) => html.indexOf(`>${words}</span>`);
    expect(at("Awaiting input")).toBeGreaterThan(-1);
    expect(at("Awaiting input")).toBeLessThan(at("In progress"));
    expect(at("In progress")).toBeLessThan(at("Todo"));
    expect(html).toContain(
      '>Todo</span><span class="external-tasks-group-count">2<',
    );
  });

  test.serial("a group shows twenty rows, then Show more", () => {
    externalTasks.value = Array.from({ length: 25 }, (_, i) =>
      row({ id: `t${i}` }),
    );
    const html = card();
    expect(html.match(/href="\/external-tasks\/t\d+"/g)).toHaveLength(20);
    expect(html).toContain("Show more");
  });

  test.serial("Open searches the list on the page, with a count", () => {
    externalTasks.value = [
      row({ id: "a", title: "Wire the sweep" }),
      row({ id: "b", title: "Draw the tab" }),
    ];
    const html = card(null, "sweep");
    expect(html).toContain('value="sweep"');
    expect(html).toContain('href="/external-tasks/a"');
    expect(html).not.toContain('href="/external-tasks/b"');
    expect(html).toContain("rows-count");
    expect(card(null, "nothing")).toContain("No task matches.");
  });

  test.serial("a project with none open says so", () => {
    externalTasks.value = [];
    expect(card()).toContain("No open tasks.");
  });

  test.serial("Done draws the server's pages, with Show more", () => {
    externalTasks.value = [row()];
    closedFilter.value = { q: "", state: "done" };
    closedPages.value = {
      rows: [row({ id: "d1", state: "done" })],
      next: "5.abcdefghijkl",
    };
    const html = card("done");
    expect(html).toContain('aria-pressed="true">Done<');
    expect(html).toContain('aria-pressed="false">Open<');
    expect(html).toContain('href="/external-tasks/d1"');
    expect(html).not.toContain('href="/external-tasks/t1"');
    expect(html).toContain("Show more");
  });

  test.serial("a closed view with none says so", () => {
    closedPages.value = { rows: [], next: null };
    expect(card("canceled")).toContain("None yet.");
    // the server searched, so the page counts nothing
    const searched = card("canceled", "sweep");
    expect(searched).toContain("No task matches.");
    expect(searched).not.toContain("rows-count");
  });
});

describe("the address", () => {
  const realLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const realHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
  const restore = (
    name: "location" | "history",
    was: PropertyDescriptor | undefined,
  ) => {
    if (was === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, was);
  };

  test.serial("a search and a pick replace it, never push", () => {
    const moves: string[] = [];
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { origin: "http://test.invalid", pathname: "/", search: "" },
    });
    Object.defineProperty(globalThis, "history", {
      configurable: true,
      value: {
        pushState: (_s: unknown, _u: string, to: string) => {
          moves.push(`push ${to}`);
        },
        replaceState: (_s: unknown, _u: string, to: string) => {
          moves.push(`replace ${to}`);
        },
      },
    });
    try {
      // the card's own handlers, as the box and the switch call them
      type Props = {
        search: VNode<{ onChange: (q: string) => void }>;
        action: VNode<{
          children: VNode<{ filters: { onPick: () => void }[] }>[];
        }>;
      };
      const card = TasksCard({
        projectId: "p1",
        show: "done",
        q: "",
        now: 2_000,
      }) as VNode<Props>;
      card.props.search.props.onChange("sweep");
      card.props.action.props.children[0]!.props.filters[2]!.onPick();
      const tab = "/projects/p1/external-tasks";
      expect(moves).toEqual([
        `replace ${tab}?show=done&q=sweep`,
        `replace ${tab}?show=canceled`,
      ]);
    } finally {
      restore("location", realLocation);
      restore("history", realHistory);
      path.value = "/";
      query.value = "";
    }
  });
});

describe("a row", () => {
  test("two lines: ring, title and labels, then who moved it last", () => {
    const html = render(
      <TaskRow row={row({ labels: ["build", "fix"] })} now={2_000} />,
    );
    expect(html).toContain("external-tasks-ring");
    expect(html).toContain('<span class="tag external-tasks-tag">build</span>');
    expect(html).toContain('<span class="tag external-tasks-tag">fix</span>');
    expect(html).toContain("Opened by @stefan");
    expect(html).toContain("rows-go-compact");
  });

  test("only awaiting input wears the attention colour", () => {
    const waiting = render(
      <TaskRow row={row({ state: "awaiting_input" })} now={2_000} />,
    );
    expect(waiting).toContain("external-tasks-ring status-attention");
    for (const state of ["todo", "in_progress", "done", "canceled"] as const) {
      expect(
        render(<TaskRow row={row({ state })} now={2_000} />),
      ).not.toContain("status-attention");
    }
  });
});
