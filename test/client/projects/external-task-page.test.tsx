// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An external task's page: the state with its icon, the chat it was made
// in by name only when the reader may open it, the scope in the aside and
// on a phone, the claim's idle deadline, an edit hiding the rest, and
// a cancel.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { TaskPage } from "../../../src/client/data/external-task.ts";
import { sinceText } from "../../../src/client/feed/Row.model.ts";
import { Icon } from "../../../src/client/lib/icons.tsx";
import {
  TaskBody,
  TaskNotice,
} from "../../../src/client/views/projects/ExternalTask.tsx";
import type {
  ExternalTaskClaim,
  ExternalTaskDetail,
  ExternalTaskRow,
} from "../../../src/shared/contracts/external-task.ts";

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
  scope: null,
  state: "open",
  revision: 1,
  editRevision: 0,
  claim: null,
  last: null,
  entries: 0,
  attentionAt: null,
  createdBy: { id: "u1", username: "stefan" },
  createdAt: NOW - 2 * HOUR,
  movedAt: NOW - 2 * HOUR,
  ...changes,
});

const page = (
  task: ExternalTaskRow = row(),
  changes: Partial<ExternalTaskDetail> = {},
): TaskPage => ({
  id: task.id,
  detail: {
    task,
    text: "Do the thing",
    files: [],
    briefAt: task.createdAt,
    chatId: null,
    chatTitle: null,
    ...changes,
  },
  entries: [],
  next: null,
  idleHours: 24,
  more: { loading: false, error: null },
  read: task.revision,
});

const draw = (p: TaskPage, edit = false) =>
  render(
    <TaskBody
      page={p}
      now={NOW}
      edit={edit}
      onEdit={() => {}}
      onClose={() => {}}
    />,
  );

// the aside's State line
const state = (html: string) =>
  html.match(
    /<div class="split-line">State<span class="split-strong">.*?<\/div>/,
  )?.[0] ?? "";
const brief = (html: string) =>
  html.match(
    /<section class="card external-tasks-brief">.*?<\/section>/,
  )?.[0] ?? "";
const aside = (html: string) =>
  html.slice(html.indexOf('<div class="split-aside">'));
const narrow = (html: string) =>
  html.match(
    /<p class="external-tasks-brief-foot external-tasks-brief-narrow">.*?<\/p>/,
  )?.[0] ?? "";

describe("the notice", () => {
  test("an open task asks for an agent to claim it and links Connect agents", () => {
    const html = render(<TaskNotice state="open" />);
    expect(html).toContain("Ask your agent to claim this task.");
    expect(html).toContain('<a class="btn btn-small" href="/connect">');
    for (const state of ["claimed", "blocked", "done", "cancelled"] as const) {
      expect(TaskNotice({ state })).toBeUndefined();
    }
    // the page draws it above the brief, and an edit hides it
    const open = draw(page());
    expect(open.indexOf("Ask your agent")).toBeLessThan(
      open.indexOf("external-tasks-brief"),
    );
    expect(draw(page(), true)).not.toContain("Ask your agent");
  });
});

describe("the state", () => {
  test("leads the aside and the phone line with its icon, never the brief", () => {
    const html = draw(page(row({ state: "claimed", claim })));
    const icon = render(
      <Icon
        name="play"
        size={14}
        class="external-tasks-state-icon status-running"
      />,
    );
    expect(state(html)).toBe(
      '<div class="split-line">State<span class="split-strong">claimed</span></div>',
    );
    expect(aside(html)).toContain(
      '<div class="split-line">Claimed by<span class="split-strong cut">@stefan via laptop</span></div>',
    );
    expect(narrow(html)).toContain(icon);
    expect(narrow(html)).toContain("<span>claimed by stefan via laptop</span>");
    expect(brief(html).replace(narrow(html), "")).not.toContain("claimed by");
    const open = draw(page());
    expect(state(open)).toContain(">open</span>");
    expect(narrow(open)).toContain(
      render(
        <Icon name="task-open" size={14} class="external-tasks-state-icon" />,
      ),
    );
  });
});

describe("the chat it was made in", () => {
  test("links only the chat's name, when the reader may open it", () => {
    const named = draw(
      page(row(), { chatId: "s1", chatTitle: "Plan the sweep" }),
    );
    expect(named).toContain(
      '<span class="external-tasks-chat"><span>Made in</span><a class="cut" href="/chat/s1">Plan the sweep</a></span>',
    );
    // Made in ends the brief panel, after the text
    expect(named.indexOf("Made in")).toBeGreaterThan(
      named.indexOf("external-tasks-brief-text"),
    );
    const hidden = draw(page(row(), { chatId: "s1", chatTitle: null }));
    expect(hidden).toContain("<span>Made in a chat</span>");
    expect(hidden).not.toContain("/chat/s1");
    expect(draw(page())).not.toContain("Made in");
    expect(draw(page(row(), { chatId: "s1", chatTitle: "" }))).toContain(
      '<a class="cut" href="/chat/s1">Untitled chat</a>',
    );
  });
});

describe("the scope", () => {
  test("sits in the aside and the phone line, after the state", () => {
    const html = draw(page(row({ scope: "part B" })));
    expect(state(html)).not.toContain("part B");
    expect(aside(html)).toContain(
      '<div class="split-line">Scope<span class="split-strong cut">part B</span></div>',
    );
    expect(narrow(html)).toContain("<span>Scope: part B</span>");
    const none = draw(page());
    expect(aside(none)).not.toContain("Scope");
    expect(narrow(none)).not.toContain("Scope");
  });
});

describe("the idle deadline", () => {
  const words = (at: number) =>
    `Unclaimed at <span class="split-strong">${sinceText(at, NOW)}</span> without a report`;

  test("is the claim's last activity plus the limit, only while claimed", () => {
    const html = draw(page(row({ state: "claimed", claim })));
    const at = claim.activeAt + 24 * HOUR;
    expect(aside(html)).toContain(words(at));
    expect(narrow(html)).toContain(
      `<span>Unclaimed at ${sinceText(at, NOW)} without a report</span>`,
    );
    expect(html).not.toContain("Opens again");
    for (const task of [
      row(),
      row({ state: "blocked", claim }),
      row({ state: "done" }),
    ]) {
      expect(draw(page(task))).not.toContain("Unclaimed at");
    }
  });

  test("moves on with a report", () => {
    const reported = { ...claim, activeAt: NOW };
    const html = draw(page(row({ state: "claimed", claim: reported })));
    expect(aside(html)).toContain(words(NOW + 24 * HOUR));
    expect(aside(html)).not.toContain(words(claim.activeAt + 24 * HOUR));
  });
});

describe("an edit", () => {
  test("shows only the form, the moves, answer and timeline hidden", () => {
    const blocked = row({ state: "blocked", claim });
    const shown = draw(page(blocked));
    expect(shown).toContain('<div class="external-tasks-rest">');
    expect(shown).toContain("external-tasks-brief");
    const editing = draw(page(blocked), true);
    expect(editing).toContain('<div class="external-tasks-rest" hidden>');
    expect(editing).not.toContain('external-tasks-brief"');
    expect(shown).not.toContain("page-notice");
    expect(editing).toContain('class="external-tasks-form"');
    // the hidden rest still holds the moves, the answer box and the
    // timeline, so a draft answer survives the edit
    const rest = editing.slice(
      editing.indexOf('<div class="external-tasks-rest" hidden>'),
    );
    expect(rest).toContain('class="external-tasks-actions"');
    expect(rest).toContain('aria-label="Answer"');
    expect(rest).toContain("Timeline");
    // moves stay off: no Edit while the form is open
    expect(rest).not.toContain(">Edit</button>");
    expect(shown).toContain("Edit</button>");
  });
});

describe("a cancel", () => {
  test("is Cancel task on a live task, and a cancelled one says so and reopens", () => {
    const open = draw(page());
    expect(open).toContain(
      `${render(<Icon name="cancelled" size={12} />)}Cancel task</button>`,
    );
    const cancelled = draw(page(row({ state: "cancelled" })));
    expect(narrow(cancelled)).toContain(
      render(
        <Icon
          name="cancelled"
          size={14}
          class="external-tasks-state-icon status-stopped"
        />,
      ),
    );
    expect(state(cancelled)).toContain(">cancelled</span>");
    expect(cancelled).not.toContain("Cancel task");
    expect(cancelled).toContain("Reopen</button>");
  });
});
