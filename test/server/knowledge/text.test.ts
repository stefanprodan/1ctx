// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  kindOf,
  lineCount,
  textFromBytes,
  textFromString,
} from "../../../src/server/knowledge/text.ts";
import fixtures from "../../fixtures/knowledge/text.json";

describe("knowledge text", () => {
  test.each(fixtures)("$name", (fixture) => {
    const readers: (() => string)[] = [];
    if (fixture.bytes !== undefined) {
      readers.push(() => textFromBytes(Uint8Array.from(fixture.bytes!)));
    }
    if (fixture.text !== undefined) {
      readers.push(() => textFromString(fixture.text!));
    }
    for (const read of readers) {
      if (fixture.invalid) expect(read).toThrow("not a text file");
      else {
        expect(read()).toBe(fixture.expected!);
        expect(lineCount(read())).toBe(fixture.lines!);
      }
    }
  });

  test("counts the last line once, with or without a newline", () => {
    expect(lineCount("one")).toBe(1);
    expect(lineCount("one\n")).toBe(1);
    expect(lineCount("one\ntwo")).toBe(2);
    expect(lineCount("\n\n")).toBe(2);
    expect(textFromString(" \t\r\n")).toBe(" \t\r\n");
    expect(kindOf("docs/runbook.MD")).toBe("md");
    expect(kindOf(".gitignore")).toBe("");
    expect(kindOf("Makefile")).toBe("");
    expect(kindOf("dir.with.dot/main.go")).toBe("go");
  });
});
