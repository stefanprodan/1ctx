// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An external task's timeline: every kind drawn with its own icon, the
// author an agent, a member, a deleted user's key or 1ctx, an answer naming its question, and
// colour only on a question still waiting for a member.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { TaskPage } from "../../../src/client/data/external-task.ts";
import { Icon } from "../../../src/client/lib/icons.tsx";
import { ENTRY_WORDS } from "../../../src/client/views/projects/ExternalTasks.model.ts";
import {
  ENTRY_ICONS,
  entryWords,
  timelineOf,
} from "../../../src/client/views/projects/ExternalTaskTimeline.model.ts";
import { Timeline } from "../../../src/client/views/projects/ExternalTaskTimeline.tsx";
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
  scope: null,
  state: "claimed",
  revision: 1,
  editRevision: 0,
  claim: claim("c1"),
  last: null,
  entries: 0,
  attentionAt: null,
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
    text: "Brief",
    files: [],
    briefAt: 0,
    chatId: null,
    chatTitle: null,
  },
  entries: written.toReversed(),
  next: null,
  idleHours: 24,
  more: { loading: false, error: null },
  read: row.revision,
});

// one rendered entry, by its row
const rows = (html: string) => html.split('class="rows-item"').slice(1);

describe("the timeline", () => {
  test("draws every kind with its own icon and word", () => {
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
    const drawn = rows(
      render(<Timeline page={page(written, task())} now={100} />),
    );
    expect(drawn).toHaveLength(written.length);
    written.toReversed().forEach((e, i) => {
      const html = drawn[i]!;
      const icon = render(
        <Icon
          name={ENTRY_ICONS[e.kind]}
          size={14}
          class="external-tasks-kind-icon"
        />,
      );
      expect(html).toContain(icon);
      expect(html).toContain(`${entryWords(e)}</span>`);
    });
    expect(ENTRY_WORDS.claim).toBe("Claimed");
  });

  test("names a sweep's unclaim by its reason after a comma", () => {
    const [access, idle, member] = rows(
      render(
        <Timeline
          page={page([
            entry("unclaim", { claimEnd: "unclaimed", claimId: "c1" }),
            entry("unclaim", { by: null, claimEnd: "idle", claimId: "c2" }),
            entry("unclaim", {
              by: null,
              keyName: null,
              claimEnd: "access_gone",
              claimId: "c3",
            }),
          ])}
          now={100}
        />,
      ),
    );
    expect(access).toContain("Unclaimed, access gone</span>");
    expect(idle).toContain("Unclaimed, idle</span>");
    expect(member).toContain("Unclaimed</span>");
  });

  test("tells an agent, a member, a deleted user's key and 1ctx apart", () => {
    const [gone, agent, member, system] = rows(
      render(
        <Timeline
          page={page([
            entry("unclaim", { by: null, claimEnd: "idle" }),
            entry("answer"),
            entry("claim"),
            entry("claim", { by: null }),
          ])}
          now={100}
        />,
      ),
    );
    expect(gone).toContain(
      '<span class="external-tasks-by-faint">a deleted user</span> via <span class="tag">laptop-claude</span>',
    );
    expect(gone).toContain('title="a deleted user via laptop-claude"');
    expect(gone).not.toContain(">1ctx<");
    expect(agent).toContain('href="/users/stefan"');
    expect(agent).toContain('<span class="rows-handle">@stefan</span>');
    expect(agent).toContain(' via <span class="tag">laptop-claude</span>');
    expect(agent).toContain('title="@stefan via laptop-claude"');
    expect(member).toContain('<span class="rows-handle">@stefan</span>');
    expect(member).not.toContain('class="tag"');
    expect(system).toContain(
      '<span class="external-tasks-by-faint">1ctx</span>',
    );
    expect(system).not.toContain("rows-handle");
  });

  test("colours only a question still waiting, and never green", () => {
    const asked = [
      entry("claim"),
      entry("question", { text: "Which\nbranch?" }),
    ];
    const waiting = render(
      <Timeline page={page(asked, task({ state: "blocked" }))} now={100} />,
    );
    expect(waiting.match(/status-attention/g)).toHaveLength(1);
    expect(rows(waiting)[0]).toContain("status-attention");
    const answered = render(
      <Timeline
        page={page([...asked, entry("answer", { text: "Main." })])}
        now={100}
      />,
    );
    expect(answered).not.toContain("status-");
    const [answer] = rows(answered);
    expect(answer).toContain('class="external-tasks-entry-pair cut"');
    expect(answer).toContain("Which branch?</p>");
    const done = render(
      <Timeline
        page={page(
          [...asked, entry("result", { claimEnd: "done" })],
          task({ state: "done", claim: null }),
        )}
        now={100}
      />,
    );
    expect(done).not.toContain("status-");
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

  test("only the latest unanswered question of the holding claim waits", () => {
    const lines = read([
      entry("claim"),
      entry("question", { text: "First?" }),
      entry("progress"),
      entry("question", { text: "Second?" }),
      entry("progress"),
    ]);
    expect(lines.map((line) => line.waiting)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(
      read(
        [entry("claim"), entry("question")],
        task({ claim: claim("c2") }),
      ).some((line) => line.waiting),
    ).toBe(false);
  });
});
