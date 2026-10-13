// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An external task's activity: oldest first, one line per entry with its
// icon and verb, who on the moves that change who holds the task, 1ctx's
// releases by their reason, an answer naming its question, colour only
// on a question still waiting, which starts open with the answer box,
// and on a task in progress the latest report open.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { TaskPage } from "../../../src/client/data/external-task.ts";
import { Icon } from "../../../src/client/lib/icons.tsx";
import { sweepReason } from "../../../src/client/views/projects/ExternalTasks.model.ts";
import {
  activityOf,
  ENTRY_ICONS,
  timelineOf,
  VERBS,
} from "../../../src/client/views/projects/ExternalTaskTimeline.model.ts";
import { Activity } from "../../../src/client/views/projects/ExternalTaskTimeline.tsx";
import type {
  ExternalTaskClaim,
  ExternalTaskEntry,
  ExternalTaskRow,
} from "../../../src/shared/contracts/external-task.ts";
import { ENTRY_KINDS } from "../../../src/shared/words.ts";

const stefan = { id: "u1", username: "stefan" };
const claim = (id: string): ExternalTaskClaim => ({
  id,
  userId: "u1",
  username: "stefan",
  keyId: "k1",
  keyName: "laptop-claude",
  startedAt: 1,
  activeAt: 1,
});

let at = 0;
// oldest first as written; the page holds them newest first
const entry = (
  kind: ExternalTaskEntry["kind"],
  changes: Partial<ExternalTaskEntry> = {},
): ExternalTaskEntry => {
  at += 1;
  const agent = ["claim", "progress", "question", "result"].includes(kind);
  return {
    id: `e${at}`,
    kind,
    text: kind === "claim" ? "" : `${kind} text`,
    links: [],
    by: stefan,
    keyName: agent ? "laptop-claude" : null,
    claimId: agent ? "c1" : null,
    claimEnd: null,
    at,
    ...changes,
  };
};

const task = (changes: Partial<ExternalTaskRow> = {}): ExternalTaskRow => ({
  id: "t1",
  projectId: "p1",
  title: "Wire the sweep",
  labels: [],
  state: "in_progress",
  revision: 1,
  editRevision: 0,
  claim: claim("c1"),
  last: null,
  entries: 0,
  createdBy: stefan,
  createdAt: 0,
  movedAt: 0,
  ...changes,
});

const page = (
  written: ExternalTaskEntry[],
  row: ExternalTaskRow = task(),
): TaskPage => ({
  id: row.id,
  detail: {
    task: { ...row, entries: written.length },
    files: [],
    briefAt: 0,
    chatId: null,
    chatTitle: null,
  },
  entries: written
    .toReversed()
    .map((entry) => ({ ...entry, html: `<p class="md-p">${entry.text}</p>` })),
  next: null,
  idleHours: 24,
  more: { loading: false, error: null },
  read: row.revision,
});

const ANSWER = <p class="answer-box">answer here</p>;

const draw = (p: TaskPage) =>
  render(<Activity page={p} now={100} answer={ANSWER} />);

// one rendered line, oldest first, after the Opened line
const rows = (html: string) => html.split("<li").slice(2);

describe("the activity", () => {
  test("draws every kind oldest first with its own icon and verb", () => {
    const written = [
      entry("claim"),
      entry("progress"),
      entry("question"),
      entry("answer"),
      entry("result", { claimEnd: "done" }),
      entry("reopen"),
      entry("cancel"),
      entry("unclaim", { by: null, claimEnd: "idle", claimId: "c1" }),
    ];
    expect(written.map((e) => e.kind).toSorted()).toEqual(
      [...ENTRY_KINDS].toSorted(),
    );
    expect(new Set(Object.values(ENTRY_ICONS)).size).toBe(ENTRY_KINDS.length);
    const html = draw(page(written, task({ state: "canceled", claim: null })));
    expect(html).toContain(
      '<span class="external-tasks-line-verb">Opened</span>',
    );
    const drawn = rows(html);
    expect(drawn).toHaveLength(written.length);
    written.forEach((e, i) => {
      const line = drawn[i]!;
      expect(line).toContain(
        `<span class="external-tasks-line-verb">${VERBS[e.kind]}</span>`,
      );
      if (e.kind === "claim") {
        // a claim wears the in-progress ring
        expect(line).toContain("external-tasks-ring");
      } else {
        expect(line).toContain(
          render(
            <Icon
              name={ENTRY_ICONS[e.kind]}
              size={14}
              class="external-tasks-line-icon"
            />,
          ),
        );
      }
    });
  });

  test("names who only on the moves that change who holds the task", () => {
    const [claimed, reported, unclaimed, answered] = rows(
      draw(
        page([
          entry("claim"),
          entry("progress"),
          entry("unclaim", { claimEnd: "unclaimed", keyName: null }),
          entry("answer"),
        ]),
      ),
    );
    expect(claimed).toContain(
      '<span class="external-tasks-line-user cut">@stefan</span><span class="external-tasks-line-via">via</span><span class="tag external-tasks-key" title="laptop-claude">laptop-claude</span>',
    );
    expect(reported).not.toContain("external-tasks-line-who");
    expect(unclaimed).toContain("@stefan");
    expect(unclaimed).not.toContain("laptop-claude");
    expect(answered).toContain("@stefan");
    // users are plain words, never a link inside the line
    expect(claimed).not.toContain("href=");
  });

  test("1ctx's release reads Unclaimed by 1ctx with its reason", () => {
    const [idle, gone, deleted] = rows(
      draw(
        page(
          [
            entry("unclaim", {
              by: null,
              keyName: null,
              claimEnd: "idle",
              text: "after 1 day without a report",
            }),
            entry("unclaim", {
              by: null,
              keyName: null,
              claimEnd: "access_gone",
              text: "access ended",
            }),
            entry("unclaim", { by: null, keyName: "laptop-claude" }),
          ],
          task({ state: "todo", claim: null }),
        ),
      ),
    );
    expect(idle).toContain(
      '<span class="external-tasks-line-via">by</span><span class="external-tasks-by-faint">1ctx</span>',
    );
    expect(idle).toContain(
      '<span class="external-tasks-line-text cut">idle</span>',
    );
    expect(gone).toContain(
      '<span class="external-tasks-line-text cut">access gone</span>',
    );
    expect(deleted).toContain(
      '<span class="external-tasks-by-faint">a deleted user</span>',
    );
    expect(sweepReason({ kind: "unclaim", claimEnd: "unclaimed" })).toBeNull();
  });

  test("a member since deleted is never 1ctx", () => {
    const base = page(
      [
        entry("answer", { by: null }),
        entry("reopen", { by: null }),
        entry("unclaim", { by: null, claimEnd: "unclaimed" }),
      ],
      task({ state: "todo", claim: null, createdBy: null }),
    );
    const html = draw(base);
    expect(html).not.toContain(">1ctx<");
    // the Opened line and each of the three
    expect(html.match(/>a deleted user</g)).toHaveLength(4);
  });

  test("the waiting question starts open, coloured, with the answer box", () => {
    const asked = [
      entry("claim"),
      entry("question", { text: "Which `branch`?\nmore" }),
    ];
    const waiting = draw(page(asked, task({ state: "awaiting_input" })));
    expect(waiting.match(/status-attention/g)).toHaveLength(1);
    const question = rows(waiting)[1]!;
    expect(question).toContain('id="question"');
    expect(question).toContain('aria-expanded="true"');
    expect(question).toContain("external-tasks-line-body");
    expect(question).toContain("answer here");
    // answered, nothing waits and no box shows
    const answered = draw(page([...asked, entry("answer", { text: "Main." })]));
    expect(answered).not.toContain("status-");
    expect(answered).not.toContain("answer here");
    // the answer, opened, names its question on one line
    const read = activityOf(
      page([...asked, entry("answer", { text: "Main." })]).entries,
      task(),
    );
    expect(read[2]!.question).toBe("Which branch?");
  });

  test("on a task in progress the latest report starts open", () => {
    const lines = rows(
      draw(
        page([
          entry("claim"),
          entry("progress", { text: "First" }),
          entry("progress", { text: "Second" }),
        ]),
      ),
    );
    expect(lines[1]).toContain('aria-expanded="false"');
    expect(lines[2]).toContain('aria-expanded="true"');
    expect(lines[2]).toContain('<p class="md-p">Second</p>');
    // a closed task opens none
    const done = rows(
      draw(
        page(
          [entry("claim"), entry("result", { claimEnd: "done" })],
          task({ state: "done", claim: null }),
        ),
      ),
    );
    expect(done.join("")).not.toContain('aria-expanded="true"');
  });

  test("a line with no words is no button", () => {
    const [claimed] = rows(draw(page([entry("claim")])));
    expect(claimed).not.toContain("<button");
  });

  test("earlier entries load with Show earlier, in the Opened line's place", () => {
    const html = draw({ ...page([entry("progress")]), next: "e0" });
    expect(html).toContain("Show earlier");
    expect(html).not.toContain(">Opened<");
  });

  test("the Opened line names the chat only when the reader may open it", () => {
    const base = page([]);
    const named = draw({
      ...base,
      detail: { ...base.detail, chatId: "s1", chatTitle: "Plan it" },
    });
    expect(named).toContain('href="/chat/s1"');
    expect(named).toContain(">Plan it</a>");
    const hidden = draw({
      ...base,
      detail: { ...base.detail, chatId: "s1", chatTitle: null },
    });
    expect(hidden).toContain("<span>a chat</span>");
    expect(hidden).not.toContain("/chat/s1");
  });

  test("a line's words are the text's first line as a reader sees it", () => {
    const read = activityOf(
      [
        entry("result", {
          text: "See [the brief](https://x.test/b) and `a_b`\nmore",
        }),
      ],
      task({ state: "done", claim: null }),
    );
    expect(read[0]!.line).toBe("See the brief and a_b");
    const open = activityOf(
      [entry("progress", { text: "" })],
      task({ state: "in_progress" }),
    );
    expect(open[0]!.open).toBe(false);
  });
});

describe("the timeline's reading", () => {
  const read = (written: ExternalTaskEntry[], row = task()) =>
    timelineOf(written.toReversed(), row).toReversed();

  test("an answer follows the latest question of its claim", () => {
    const lines = read([
      entry("claim"),
      entry("question", { text: "First?" }),
      entry("progress"),
      entry("question", { text: "Second?" }),
      entry("answer"),
      entry("answer"),
    ]);
    expect(lines.map((line) => line.question)).toEqual([
      null,
      null,
      null,
      null,
      "Second?",
      "Second?",
    ]);
    expect(lines.some((line) => line.waiting)).toBe(false);
  });

  test("a claim starts afresh, so a new claim's answer names nothing", () => {
    const lines = read(
      [
        entry("claim"),
        entry("question", { text: "Stuck?" }),
        entry("unclaim", { claimEnd: "unclaimed" }),
        entry("claim", { claimId: "c2" }),
        entry("answer"),
      ],
      task({ claim: claim("c2") }),
    );
    expect(lines.map((line) => line.question)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(lines.some((line) => line.waiting)).toBe(false);
  });

  test("only the question that blocks the task waits", () => {
    const asked = [
      entry("claim"),
      entry("question", { text: "First?" }),
      entry("progress"),
      entry("question", { text: "Second?" }),
    ];
    const blocked = task({ state: "awaiting_input" });
    expect(read(asked, blocked).map((line) => line.waiting)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    // the agent's own progress moves it on: nothing waits any more
    expect(
      read([...asked, entry("progress")], task({ state: "in_progress" })).some(
        (line) => line.waiting,
      ),
    ).toBe(false);
    expect(
      read(
        [entry("claim"), entry("question")],
        task({ state: "awaiting_input", claim: claim("c2") }),
      ).some((line) => line.waiting),
    ).toBe(false);
  });
});
