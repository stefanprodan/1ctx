// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The awk record reader on its own: each call reads one record under the
// RS it is given, and says what ended it.

import { describe, expect, test } from "bun:test";
import { nextRecord } from "../../../vendor/just-bash/src/commands/awk/interpreter/records.ts";

function all(text: string, rs: string): [string, string][] {
  const out: [string, string][] = [];
  let pos = 0;
  for (;;) {
    const r = nextRecord(text, pos, rs);
    if (!r) return out;
    out.push([r.record, r.rt]);
    pos = r.next;
  }
}

describe("the awk record reader", () => {
  test("a newline separates, and a final one makes no empty record", () => {
    expect(all("a\nb\n", "\n")).toEqual([
      ["a", "\n"],
      ["b", "\n"],
    ]);
    expect(all("a\nb", "\n")).toEqual([
      ["a", "\n"],
      ["b", ""],
    ]);
    expect(all("", "\n")).toEqual([]);
  });

  test("a single character separates literally", () => {
    expect(all(";a;b;;", ";")).toEqual([
      ["", ";"],
      ["a", ";"],
      ["b", ";"],
      ["", ";"],
    ]);
    expect(all("a.b", ".")).toEqual([
      ["a", "."],
      ["b", ""],
    ]);
  });

  test("a CR stays in the record under the default RS", () => {
    expect(all("a\r\nb\r\n", "\n")).toEqual([
      ["a\r", "\n"],
      ["b\r", "\n"],
    ]);
  });

  test("paragraph mode skips leading newlines and keeps each run as RT", () => {
    expect(all("\n\na\nb\n\n\nc\n", "")).toEqual([
      ["a\nb", "\n\n\n"],
      ["c", "\n"],
    ]);
    expect(all("a\n\nb", "")).toEqual([
      ["a", "\n\n"],
      ["b", ""],
    ]);
    expect(all("a\n\n\n", "")).toEqual([["a", "\n\n\n"]]);
    expect(all("\n\n", "")).toEqual([]);
  });

  test("paragraph mode does not take a CRLF line for a blank one", () => {
    expect(all("a\r\n\r\nb\r\n", "")).toEqual([["a\r\n\r\nb\r", "\n"]]);
  });

  test("two or more characters are a regular expression", () => {
    expect(all("12a3b44c", "[0-9]+")).toEqual([
      ["", "12"],
      ["a", "3"],
      ["b", "44"],
      ["c", ""],
    ]);
    expect(all("a\r\nb\nc\r\n", "\r?\n")).toEqual([
      ["a", "\r\n"],
      ["b", "\n"],
      ["c", "\r\n"],
    ]);
    expect(all("x---y---", "---")).toEqual([
      ["x", "---"],
      ["y", "---"],
    ]);
  });

  test("the RS of each call applies from where the last record ended", () => {
    const text = "a\nb;c";
    const first = nextRecord(text, 0, "\n");
    expect(first).toEqual({ record: "a", rt: "\n", next: 2 });
    expect(nextRecord(text, first?.next ?? 0, ";")).toEqual({
      record: "b",
      rt: ";",
      next: 4,
    });
  });

  test("a separator that matches the empty string is refused", () => {
    for (const rs of ["X*", "a?", "\n*"]) {
      expect(() => nextRecord("aXb", 0, rs)).toThrow(
        "RS matches the empty string",
      );
    }
  });

  test("an invalid expression is an error", () => {
    expect(() => nextRecord("a", 0, "a(")).toThrow();
  });

  test("an aborted signal stops it", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => nextRecord("a\nb", 0, "\n", controller.signal)).toThrow(
      "execution aborted",
    );
  });
});
