// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An external task's page: the title as its heading with the state's
// line, a done task's result first, the files opening in place, the
// aside's labels, claim and idle deadline, the head's moves, an edit
// hiding the rest, and the form's labels and files.

import { afterEach, describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { render } from "preact-render-to-string";
import {
  type TaskPage,
  taskPage,
} from "../../../src/client/data/external-task.ts";
import {
  taskFileKey,
  taskFiles,
} from "../../../src/client/data/external-task-files.ts";
import { rememberTasksView } from "../../../src/client/data/external-tasks.ts";
import { project } from "../../../src/client/data/projects.ts";
import { Save } from "../../../src/client/lib/save.ts";
import {
  ExternalTask,
  jumpToQuestion,
  TaskBody,
  TaskNotice,
} from "../../../src/client/views/projects/ExternalTask.tsx";
import { TaskFiles } from "../../../src/client/views/projects/ExternalTaskFiles.tsx";
import {
  NewExternalTask,
  TaskForm,
} from "../../../src/client/views/projects/ExternalTaskForm.tsx";
import {
  HeadMoves,
  type MoveState,
} from "../../../src/client/views/projects/ExternalTaskMoves.tsx";
import { NO_LABEL } from "../../../src/client/views/projects/ExternalTasks.model.ts";
import type {
  ExternalTaskClaim,
  ExternalTaskDetail,
  ExternalTaskPageEntry,
  ExternalTaskRow,
} from "../../../src/shared/contracts/external-task.ts";
import type { ProjectDetail } from "../../../src/shared/contracts/project.ts";

const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 12, 9, 0).getTime();

const claim: ExternalTaskClaim = {
  id: "c1",
  userId: "u1",
  username: "stefan",
  keyId: "k1",
  keyName: "laptop",
  startedAt: NOW - HOUR,
  activeAt: NOW - HOUR,
};

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
  claimLimit: false,
  createdBy: { id: "u1", username: "stefan" },
  createdAt: NOW - 2 * HOUR,
  movedAt: NOW - 2 * HOUR,
  ...changes,
});

const page = (
  task: ExternalTaskRow = row(),
  changes: Partial<ExternalTaskDetail> = {},
  entries: ExternalTaskPageEntry[] = [],
): TaskPage => ({
  id: task.id,
  detail: {
    task,
    files: [],
    briefAt: task.createdAt,
    chatId: null,
    chatTitle: null,
    ...changes,
  },
  entries,
  next: null,
  idleHours: 24,
  more: { loading: false, error: null },
  read: task.revision,
});

const moves = (): MoveState => ({
  opened: signal(null),
  asking: signal(false),
  answer: signal(""),
  save: new Save(async () => {}),
});

const draw = (p: TaskPage, edit = false, held: MoveState = moves()) =>
  render(
    <TaskBody page={p} moves={held} now={NOW} edit={edit} onClose={() => {}} />,
  );

const aside = (html: string) =>
  html.slice(html.indexOf('<div class="split-aside">'));
const head = (html: string) =>
  html.match(/<header class="external-tasks-head">.*?<\/header>/)?.[0] ?? "";

const PROJECT: ProjectDetail = {
  id: "p1",
  kind: "team",
  name: "infra",
  createdAt: 0,
  memberCount: 1,
  description: "",
  members: [],
  labels: [
    { id: "l1", name: "build", description: "", tasks: 1 },
    { id: "l2", name: "fix", description: "", tasks: 0 },
    { id: "l3", name: "plan", description: "", tasks: 0 },
  ],
  chats: 0,
  knowledge: { files: 0, tokens: 0 },
  latestFiles: [],
};

afterEach(() => {
  project.value = null;
  taskPage.value = null;
  taskFiles.value = new Map();
});

describe("the crumb", () => {
  // the External tasks crumb, the head's one link styled as the title
  const crumb = (state: ExternalTaskRow["state"], projectId = "p1") => {
    taskPage.value = page(row({ state, projectId }));
    const html = render(<ExternalTask params={{ id: "t1" }} />);
    return html
      .match(/<a class="page-crumb-on[^"]*" href="([^"]*)"/)?.[1]
      ?.replaceAll("&amp;", "&");
  };

  test.serial("returns to the view the task is listed on", () => {
    const tab = "/projects/p1/external-tasks";
    expect(crumb("done")).toBe(`${tab}?show=done`);
    expect(crumb("canceled")).toBe(`${tab}?show=canceled`);
    // a reopen or any open state lands on Open
    for (const state of ["todo", "in_progress", "awaiting_input"] as const) {
      expect(crumb(state)).toBe(tab);
    }
  });

  test.serial("returns to the tab as it was left, the form too", () => {
    const tab = "/projects/p7/external-tasks";
    rememberTasksView("p7", { show: "canceled", q: "sweep" });
    expect(crumb("done", "p7")).toBe(`${tab}?show=canceled&q=sweep`);
    expect(crumb("todo", "p7")).toBe(`${tab}?show=canceled&q=sweep`);
    project.value = { ...PROJECT, id: "p7" };
    const form = render(<NewExternalTask params={{ id: "p7" }} />);
    expect(form).toContain(
      `class="page-crumb-up" href="${tab}?show=canceled&amp;q=sweep"`,
    );
  });
});

describe("the notice", () => {
  test("a todo task asks for an agent to claim it", () => {
    const html = render(<TaskNotice state="todo" claimLimit={false} />);
    expect(html).toContain("Ask your agent to claim this task.");
    expect(html).toContain('<a class="btn btn-small" href="/connect">');
    for (const state of [
      "in_progress",
      "awaiting_input",
      "done",
      "canceled",
    ] as const) {
      expect(TaskNotice({ state, claimLimit: false })).toBeUndefined();
    }
    expect(draw(page(), true)).toContain(
      '<div class="external-tasks-rest" hidden>',
    );
  });

  test("a todo task at the claim cap says to cancel and reopen it, with no Connect", () => {
    const html = render(<TaskNotice state="todo" claimLimit />);
    expect(html).toContain(
      "Agents can't claim this task again. Cancel and reopen it to start over.",
    );
    expect(html).not.toContain("/connect");
  });
});

describe("the head", () => {
  test("the title is the heading, then the state and when it moved", () => {
    const html = head(draw(page(row({ state: "in_progress", claim }))));
    expect(html).toContain(
      '<h2 class="external-tasks-title">Wire the sweep</h2>',
    );
    expect(html).toContain("In progress");
    expect(html).toContain("Updated 2h ago");
    // never who
    expect(html).not.toContain("stefan");
  });

  test("awaiting input links to the question, in the attention colour", () => {
    const html = head(draw(page(row({ state: "awaiting_input", claim }))));
    expect(html).toContain(
      '<a class="external-tasks-status-jump" href="#question">Awaiting input</a>',
    );
    expect(html).toContain("Asked 2h ago");
    expect(html).toContain("status-attention");
  });

  test.serial("the jump scrolls to the question, past the router", () => {
    const scrolled: unknown[] = [];
    const real = globalThis.document;
    globalThis.document = {
      getElementById: (id: string) =>
        id === "question"
          ? { scrollIntoView: (how: unknown) => scrolled.push(how) }
          : null,
    } as unknown as Document;
    let prevented = false;
    try {
      jumpToQuestion({
        preventDefault: () => {
          prevented = true;
        },
      } as Event);
    } finally {
      globalThis.document = real;
    }
    // the router skips a click already handled, so the hash never drops
    expect(prevented).toBe(true);
    expect(scrolled).toEqual([{ behavior: "smooth", block: "start" }]);
  });

  test("the labels sit under it for a phone, and in the aside", () => {
    const html = draw(page(row({ labels: ["build", "fix"] })));
    expect(head(html)).toContain(
      '<p class="external-tasks-head-labels external-tasks-narrow"><span class="tag external-tasks-tag">build</span><span class="tag external-tasks-tag">fix</span></p>',
    );
    expect(aside(html)).toContain('<span class="split-label">Labels</span>');
    expect(aside(html)).toContain(
      '<span class="tag external-tasks-tag">fix</span>',
    );
    expect(aside(draw(page()))).not.toContain("Labels");
  });
});

describe("the answer box", () => {
  const asked: ExternalTaskPageEntry = {
    id: "e2",
    kind: "question",
    text: "Which branch?",
    html: '<p class="md-p">Which branch?</p>',
    links: [],
    by: { id: "u1", username: "stefan" },
    keyName: "laptop",
    claimId: "c1",
    claimEnd: null,
    chatId: null,
    chatTitle: null,
    at: NOW - HOUR,
  };

  test("its draft is the page's, so folding the question keeps it", () => {
    const held = moves();
    held.answer.value = "Use main";
    const html = draw(
      page(row({ state: "awaiting_input", claim }), {}, [asked]),
      false,
      held,
    );
    // one box, at the foot of the waiting question, showing the draft
    expect(html.match(/aria-label="Answer"/g)).toHaveLength(1);
    expect(html).toContain(">Use main</textarea>");
    expect(html.indexOf('id="question"')).toBeLessThan(
      html.indexOf('aria-label="Answer"'),
    );
  });

  test("with no question among those read, the box still shows", () => {
    const html = draw(page(row({ state: "awaiting_input", claim })));
    expect(html.match(/aria-label="Answer"/g)).toHaveLength(1);
  });
});

describe("the aside", () => {
  const ends = (when: string) =>
    `<span class="split-label">Claim ends</span><span class="split-strong">${when}</span>`;

  test("names the claim and when the idle sweep ends it, never the state", () => {
    const html = aside(draw(page(row({ state: "in_progress", claim }))));
    expect(html).toContain(
      '<div class="split-line split-pair"><span class="split-label">Claimed by</span><span class="split-strong"><a class="split-handle" href="/users/stefan">@stefan</a> via <span class="split-word" title="laptop">laptop</span></span></div>',
    );
    expect(html).toContain(ends("13 October 2026, 08:00"));
    expect(html).not.toContain(">State<");
    expect(html).not.toContain("Created by");
    expect(html).toContain(">Created<");
    for (const task of [
      row(),
      row({ state: "awaiting_input", claim }),
      row({ state: "done" }),
    ]) {
      expect(draw(page(task))).not.toContain("Claim ends");
    }
  });

  test("says when the brief was edited", () => {
    const task = row();
    const html = aside(draw(page(task, { briefAt: NOW - HOUR })));
    expect(html).toContain('<span class="split-label">Edited</span>');
  });
});

describe("a done task", () => {
  test("leads with its result, whole, before the files", () => {
    const result: ExternalTaskPageEntry = {
      id: "e2",
      kind: "result",
      text: "Shipped in #12",
      html: '<p class="md-p">Shipped in #12</p>',
      links: ["https://example.test/pr/12"],
      by: { id: "u1", username: "stefan" },
      keyName: "laptop",
      claimId: "c1",
      claimEnd: "done",
      chatId: null,
      chatTitle: null,
      at: NOW - HOUR,
    };
    const html = draw(
      page(
        row({ state: "done" }),
        {
          files: [
            {
              fileId: "f1",
              name: "plan.md",
              revision: 1,
              changedAt: 1,
              deleted: false,
            },
          ],
        },
        [result],
      ),
    );
    expect(html).toContain('aria-label="Result"');
    expect(html).toContain(
      '<span class="external-tasks-line-user cut">@stefan</span>',
    );
    expect(html).toContain('<p class="md-p">Shipped in #12</p>');
    expect(html).toContain('href="https://example.test/pr/12"');
    expect(html.indexOf('aria-label="Result"')).toBeLessThan(
      html.indexOf("plan.md"),
    );
    expect(
      draw(page(row({ state: "in_progress", claim }), {}, [result])),
    ).not.toContain('aria-label="Result"');
  });
});

describe("the files", () => {
  const files: ExternalTaskDetail["files"] = [
    {
      fileId: "f1",
      name: "plan.md",
      revision: 3,
      changedAt: 1,
      deleted: false,
    },
    {
      fileId: "f2",
      name: "old.md",
      revision: null,
      changedAt: null,
      deleted: true,
    },
  ];

  test("each opens in place, its pencil the way to its page", () => {
    const html = render(<TaskFiles detail={page(row(), { files }).detail} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/href="[^"]*\/files\/f1" aria-label="Edit plan.md"/);
    // a deleted file keeps its row, drawn as a live one so the two line
    // up, with no way to open it
    expect(html).toContain(
      '<div class="external-tasks-file-row external-tasks-file-row-off"><span class="external-tasks-file-go external-tasks-file-gone">',
    );
    expect(html).toContain(
      '<span class="external-tasks-file-name cut">deleted: old.md</span>',
    );
    expect(html).not.toContain("/files/f2");
    expect(taskFileKey("f1", 3)).not.toBe(taskFileKey("f1", 4));
  });

  test("none, no card", () => {
    expect(render(<TaskFiles detail={page().detail} />)).toBe("");
  });
});

describe("the head's moves", () => {
  const head = (task: ExternalTaskRow, editing = false) =>
    render(
      <HeadMoves
        task={task}
        moves={moves()}
        onEdit={editing ? null : () => {}}
      />,
    );

  test("a closed task's Reopen is the one button, the rest in More", () => {
    for (const state of ["done", "canceled"] as const) {
      const html = head(row({ state }));
      expect(html).toContain("Reopen</button>");
      expect(html).toContain('aria-label="More"');
    }
    const open = head(row());
    expect(open).not.toContain("Reopen");
    expect(open).toContain('aria-label="More"');
  });

  test("an open form leaves no move in the head", () => {
    expect(head(row(), true)).toBe("");
  });
});

describe("an edit", () => {
  test("shows only the form, the rest hidden with its answer box", () => {
    const blocked = row({ state: "awaiting_input", claim });
    const shown = draw(page(blocked));
    expect(shown).toContain('<div class="external-tasks-rest">');
    expect(shown).toContain('class="external-tasks-head"');
    const editing = draw(page(blocked), true);
    expect(editing).toContain('<div class="external-tasks-rest" hidden>');
    expect(editing).not.toContain('class="external-tasks-head"');
    expect(editing).toContain('class="external-tasks-form"');
    const rest = editing.slice(
      editing.indexOf('<div class="external-tasks-rest" hidden>'),
    );
    expect(rest).toContain('aria-label="Answer"');
    expect(rest).toContain("Activity");
  });
});

describe("the form", () => {
  const form = (detail: ExternalTaskDetail | null) =>
    render(
      <TaskForm
        projectId="p1"
        detail={detail}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    );

  test("picks labels from the project, at most three", () => {
    project.value = PROJECT;
    const html = form(page(row({ labels: ["build"] })).detail);
    expect(html).toContain("Add label");
    expect(html).toContain("build");
    const full = form(page(row({ labels: ["build", "fix", "plan"] })).detail);
    expect(full).toContain('title="At most 3 labels"');
    // a name the project no longer has is not shown as picked
    const gone = form(page(row({ labels: ["build", "old"] })).detail);
    expect(gone).not.toContain("Remove old");
    expect(gone).toContain('aria-label="Remove build"');
  });

  test("a task with no label left opens asking for one", () => {
    project.value = PROJECT;
    const html = form(page(row({ labels: [] })).detail);
    expect(html).toContain(`<span class="field-error">${NO_LABEL}</span>`);
    // a new task waits for its first save to say so
    expect(form(null)).not.toContain(NO_LABEL);
  });

  test("files link from the project or are made here, at most five", () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      fileId: `f${i}`,
      name: `f${i}.md`,
      revision: 1,
      changedAt: 1,
      deleted: false,
    }));
    const full = form(page(row({ labels: ["build"] }), { files }).detail);
    expect(full).toContain("Link file");
    expect(full).toContain("New file</button>");
    expect(full.match(/title="At most 5 files"/g)).toHaveLength(2);
    // the scope and the text are gone
    expect(full).not.toContain("Scope");
    expect(full).not.toContain('name="text"');
  });
});
