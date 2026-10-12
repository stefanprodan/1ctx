// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An external task's page: the state with its icon, the chat it was made
// in by name only when the reader may open it, the scope in the aside and
// on a phone, the claim's idle deadline, and an edit hiding the rest.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { TaskPage } from "../../../src/client/data/external-task.ts";
import { sinceText } from "../../../src/client/feed/Row.model.ts";
import { Icon } from "../../../src/client/lib/icons.tsx";
import { TaskBody } from "../../../src/client/views/projects/ExternalTask.tsx";
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

const state = (html: string) =>
  html.match(/<p class="external-tasks-brief-state">.*?<\/p>/)?.[0] ?? "";
const aside = (html: string) =>
  html.slice(html.indexOf('<div class="split-aside">'));
const narrow = (html: string) =>
  html.match(
    /<p class="external-tasks-brief-foot external-tasks-brief-narrow">.*?<\/p>/,
  )?.[0] ?? "";

describe("the state line", () => {
  test("draws the state's icon in its colour before the words", () => {
    const claimed = state(draw(page(row({ state: "claimed", claim }))));
    expect(claimed).toContain(
      render(
        <Icon
          name="play"
          size={15}
          class="external-tasks-brief-icon status-running"
        />,
      ),
    );
    expect(claimed).toContain("<span>claimed by stefan via laptop</span>");
    const open = state(draw(page()));
    expect(open).toContain(
      render(
        <Icon name="task-open" size={15} class="external-tasks-brief-icon" />,
      ),
    );
    expect(open).toContain("<span>open</span>");
  });
});

describe("the chat it was made in", () => {
  test("names and links the chat only when the reader may open it", () => {
    const named = draw(
      page(row(), { chatId: "s1", chatTitle: "Plan the sweep" }),
    );
    expect(named).toContain(
      '<a class="external-tasks-chat" href="/chat/s1"><span>Made in</span><span class="cut">Plan the sweep</span>',
    );
    expect(named).toContain(
      render(<Icon name="open" size={12} class="external-tasks-chat-icon" />),
    );
    const hidden = draw(page(row(), { chatId: "s1", chatTitle: null }));
    expect(hidden).toContain("<span>Made in a chat</span>");
    expect(hidden).not.toContain("/chat/s1");
    expect(draw(page())).not.toContain("Made in");
    expect(draw(page(row(), { chatId: "s1", chatTitle: "" }))).toContain(
      '<span class="cut">Untitled chat</span>',
    );
  });
});

describe("the scope", () => {
  test("sits in the aside and the phone line, never the state line", () => {
    const html = draw(page(row({ scope: "part B" })));
    expect(state(html)).not.toContain("part B");
    expect(aside(html)).toContain(
      '<div class="split-line">Scope<span class="split-strong cut">part B</span></div>',
    );
    expect(narrow(html)).toContain("<span>Scope: part B</span>");
    const none = draw(page());
    expect(aside(none)).not.toContain("Scope");
    expect(narrow(none)).toBe("");
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
    expect(editing).not.toContain("external-tasks-brief-state");
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
