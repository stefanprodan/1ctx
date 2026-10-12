// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  type Actor,
  type Brief,
  checkBrief,
  checkEntry,
  checkRoom,
  type Move,
  transition,
} from "../../../src/server/external-tasks/rules.ts";
import {
  CLOSING_ENTRIES,
  MAX_BRIEF_BYTES,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_ENTRY_LINKS,
  MAX_LINK_BYTES,
  MAX_SCOPE,
  MAX_TASK_FILES,
} from "../../../src/shared/contracts/external-task.ts";
import {
  ENTRY_KINDS,
  EXTERNAL_TASK_STATES,
  type ExternalTaskState,
  MAX_TITLE,
} from "../../../src/shared/words.ts";
import { refuses } from "./fixture.ts";

const allowed = new Map<string, ExternalTaskState>([
  ["agent/open/claim", "claimed"],
  ["agent/claimed/progress", "claimed"],
  ["agent/blocked/progress", "claimed"],
  ["agent/claimed/question", "blocked"],
  ["agent/claimed/result", "done"],
  ["agent/blocked/result", "done"],
  ["agent/claimed/unclaim", "open"],
  ["agent/blocked/unclaim", "open"],
  ["member/blocked/answer", "claimed"],
  ["member/claimed/answer", "claimed"],
  ["member/claimed/unclaim", "open"],
  ["member/blocked/unclaim", "open"],
  ["member/open/cancel", "cancelled"],
  ["member/claimed/cancel", "cancelled"],
  ["member/blocked/cancel", "cancelled"],
  ["member/done/reopen", "open"],
  ["member/cancelled/reopen", "open"],
  ["idle/claimed/unclaim", "open"],
  ["access_gone/claimed/unclaim", "open"],
  ["access_gone/blocked/unclaim", "open"],
]);

describe("external task transitions", () => {
  const actors: Actor[] = ["agent", "member", "idle", "access_gone"];
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

describe("external task validation", () => {
  const brief: Brief = { title: "Work", text: "", scope: null, fileIds: [] };
  test("brief fields accept their exact bounds, counting bytes for text", () => {
    expect(() =>
      checkBrief({
        title: "\u{1f600}".repeat(MAX_TITLE),
        scope: "p".repeat(MAX_SCOPE),
        text: "\u00e9".repeat(MAX_BRIEF_BYTES / 2),
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
      { scope: "p".repeat(MAX_SCOPE + 1) },
      { text: `${"\u00e9".repeat(MAX_BRIEF_BYTES / 2)}a` },
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

  test("only closing entries fit the reserved tail, and none passes the hard cap", () => {
    for (const kind of ["claim", ...ENTRY_KINDS] satisfies Move[]) {
      expect(() => checkRoom(CLOSING_ENTRIES - 1, kind)).not.toThrow();
      if (["result", "unclaim", "cancel"].includes(kind)) {
        expect(() => checkRoom(CLOSING_ENTRIES, kind)).not.toThrow();
        expect(() => checkRoom(MAX_ENTRIES - 1, kind)).not.toThrow();
      } else refuses(() => checkRoom(CLOSING_ENTRIES, kind), 409);
      refuses(() => checkRoom(MAX_ENTRIES, kind), 409);
    }
  });
});
