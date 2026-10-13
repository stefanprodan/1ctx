// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  type Actor,
  type AgentMove,
  type Brief,
  checkBrief,
  checkEntry,
  checkMove,
  checkRoom,
  type Move,
  transition,
} from "../../../src/server/external-tasks/rules.ts";
import {
  CLOSING_ENTRIES,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_ENTRY_LINKS,
  MAX_LINK_BYTES,
  MAX_TASK_FILES,
  MAX_TASK_LABELS,
} from "../../../src/shared/contracts/external-task.ts";
import {
  ENTRY_KINDS,
  EXTERNAL_TASK_STATES,
  type ExternalTaskState,
  MAX_TITLE,
} from "../../../src/shared/words.ts";
import { refuses } from "./fixture.ts";

const allowed = new Map<string, ExternalTaskState>([
  ["agent/todo/claim", "in_progress"],
  ["agent/in_progress/progress", "in_progress"],
  ["agent/awaiting_input/progress", "in_progress"],
  ["agent/in_progress/question", "awaiting_input"],
  ["agent/awaiting_input/question", "awaiting_input"],
  ["agent/in_progress/result", "done"],
  ["agent/awaiting_input/result", "done"],
  ["agent/in_progress/unclaim", "todo"],
  ["agent/awaiting_input/unclaim", "todo"],
  ["member/awaiting_input/answer", "in_progress"],
  ["member/in_progress/answer", "in_progress"],
  ["member/in_progress/unclaim", "todo"],
  ["member/awaiting_input/unclaim", "todo"],
  ["member/todo/cancel", "canceled"],
  ["member/in_progress/cancel", "canceled"],
  ["member/awaiting_input/cancel", "canceled"],
  ["member/done/reopen", "todo"],
  ["member/canceled/reopen", "todo"],
  ["idle/in_progress/unclaim", "todo"],
  ["access_gone/in_progress/unclaim", "todo"],
  ["access_gone/awaiting_input/unclaim", "todo"],
  ["limit/in_progress/unclaim", "todo"],
  ["limit/awaiting_input/unclaim", "todo"],
]);

describe("external task transitions", () => {
  const actors: Actor[] = ["agent", "member", "idle", "access_gone", "limit"];
  const moves: Move[] = ["claim", ...ENTRY_KINDS];
  for (const actor of actors) {
    for (const state of EXTERNAL_TASK_STATES) {
      for (const move of moves) {
        test(`${actor} ${state} ${move}`, () => {
          expect(transition(state, move, actor)).toBe(
            allowed.get(`${actor}/${state}/${move}`) ?? null,
          );
        });
      }
    }
  }
});

describe("refused moves", () => {
  test("name the state as the page says it, for every actor", () => {
    const words: Record<ExternalTaskState, string> = {
      todo: "this task is todo",
      in_progress: "this task is in progress",
      awaiting_input: "this task is awaiting input",
      done: "this task is done",
      canceled: "this task is canceled",
    };
    const actors: Actor[] = ["agent", "member", "idle", "access_gone", "limit"];
    for (const actor of actors) {
      for (const state of EXTERNAL_TASK_STATES) {
        for (const move of ENTRY_KINDS) {
          if (allowed.has(`${actor}/${state}/${move}`)) continue;
          refuses(() => checkMove(state, move, actor), 409, words[state]);
        }
      }
    }
  });
});

describe("external task validation", () => {
  const brief: Brief = { title: "Work", labels: ["build"], fileIds: ["f"] };
  test("brief fields accept their exact bounds", () => {
    expect(() =>
      checkBrief({
        title: "\u{1f600}".repeat(MAX_TITLE),
        labels: Array.from({ length: MAX_TASK_LABELS }, (_, i) => `l${i}`),
        fileIds: Array.from({ length: MAX_TASK_FILES }, (_, i) => `f${i}`),
      }),
    ).not.toThrow();
    for (const patch of [
      { title: "" },
      { title: " \t " },
      { title: "a\nb" },
      { title: "a\rb" },
      { title: "a\u2028b" },
      { title: "a".repeat(MAX_TITLE + 1) },
      { labels: [] },
      {
        labels: Array.from({ length: MAX_TASK_LABELS + 1 }, (_, i) => `l${i}`),
      },
      { labels: ["build", "build"] },
      // shaped before they are compared, as a save shapes them
      { labels: ["build", " Build "] },
      { labels: [" "] },
      { fileIds: [] },
      {
        fileIds: Array.from({ length: MAX_TASK_FILES + 1 }, (_, i) => `f${i}`),
      },
      { fileIds: ["same", "same"] },
      { fileIds: [""] },
    ])
      refuses(() => checkBrief({ ...brief, ...patch }), 400);
  });

  test("entry bytes and http links accept exactly their bounds", () => {
    const link = `https://example.com/${"x".repeat(MAX_LINK_BYTES - 20)}`;
    expect(Buffer.byteLength(link)).toBe(MAX_LINK_BYTES);
    expect(() =>
      checkEntry(
        "result",
        "\u00e9".repeat(MAX_ENTRY_BYTES / 2),
        Array(MAX_ENTRY_LINKS).fill(link),
      ),
    ).not.toThrow();
    for (const [text, links] of [
      ["", []],
      [" \n ", []],
      ["x".repeat(MAX_ENTRY_BYTES + 1), []],
      ["x", [`${link}x`]],
      ["x", Array(MAX_ENTRY_LINKS + 1).fill(link)],
      ["x", ["ftp://example.com"]],
      ["x", ["javascript:alert(1)"]],
      ["x", ["/relative"]],
      ["x", ["not a url"]],
    ] satisfies [string, string[]][])
      refuses(() => checkEntry("progress", text, links), 400);
    expect(() => checkEntry("cancel", "", [])).not.toThrow();
  });

  test("only an agent's closing moves fit the reserved tail, its unclaim passes the hard cap too", () => {
    const moves: AgentMove[] = [
      "claim",
      "progress",
      "question",
      "result",
      "unclaim",
    ];
    for (const kind of moves) {
      expect(() => checkRoom(CLOSING_ENTRIES - 1, kind)).not.toThrow();
      if (["result", "unclaim"].includes(kind)) {
        expect(() => checkRoom(CLOSING_ENTRIES, kind)).not.toThrow();
        expect(() => checkRoom(MAX_ENTRIES - 1, kind)).not.toThrow();
      } else refuses(() => checkRoom(CLOSING_ENTRIES, kind), 409);
      if (kind === "unclaim") {
        expect(() => checkRoom(MAX_ENTRIES, kind)).not.toThrow();
      } else refuses(() => checkRoom(MAX_ENTRIES, kind), 409);
    }
  });
});
