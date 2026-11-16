// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chat export on recorded rows: what a turn writes when it ends
// done, stopped, failed or cut, what stays out, and that the text and
// the times arrive as the transcript showed them.

import { describe, expect, test } from "bun:test";
import {
  chatMarkdown,
  type ExportRow,
  markdownFilename,
} from "../../src/server/sessions/index.ts";

type Fixture = {
  name: string;
  title?: string;
  timeZone?: string;
  rows: ExportRow[];
  expected: string;
};

const fixtures = (await Bun.file(
  new URL("../fixtures/sessions/markdown.json", import.meta.url),
).json()) as Fixture[];

describe("chatMarkdown", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      expect(
        chatMarkdown(
          fixture.title ?? "chat",
          fixture.rows,
          fixture.timeZone ?? "UTC",
        ),
      ).toBe(fixture.expected);
    });
  }
});

describe("chatMarkdown bodies", () => {
  const [turn] = fixtures;
  const write = (question: string, answer: string) =>
    chatMarkdown(
      "chat",
      turn!.rows.map((row) =>
        row.id === "m1-1"
          ? { ...row, content: question }
          : row.id === "m1-4"
            ? { ...row, content: answer }
            : row,
      ),
      "UTC",
    );
  const expected = (question: string, answer: string) =>
    turn!.expected
      .replace("what time is it?", question)
      .replace("It is noon.", answer);

  test("drops the blank lines that end a body", () => {
    expect(write("  what?\r\n \n\t", "noon.  \n \r\n\t\n")).toBe(
      expected("  what?", "noon.  "),
    );
    expect(write("what?\r", "noon.\n\r")).toBe(
      expected("what?\r", "noon.\n\r"),
    );
  });

  test("writes a body of long runs of line breaks", () => {
    const breaks = "\n".repeat(262_000);
    expect(write(`a${breaks}b`, `It is${breaks}`)).toBe(
      expected(`a${breaks}b`, "It is"),
    );
    expect(write("what?", `noon.${"\r\n \t".repeat(100_000)}`)).toBe(
      expected("what?", "noon."),
    );
  });
});

describe("markdownFilename", () => {
  test("slugs the title and falls back to chat", () => {
    expect(markdownFilename("Hello, World!")).toBe("hello-world.md");
    expect(markdownFilename("What's new in K8s")).toBe("whats-new-in-k8s.md");
    expect(markdownFilename("Café déjà vu")).toBe("cafe-deja-vu.md");
    expect(markdownFilename('say "hi"\r\nX-Evil: 1')).toBe(
      "say-hi-x-evil-1.md",
    );
    expect(markdownFilename("日本語")).toBe("chat.md");
    expect(markdownFilename(`${"a".repeat(59)} b`)).toBe(
      `${"a".repeat(59)}.md`,
    );
  });
});
