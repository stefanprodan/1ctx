// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// cleanText walks by code point and drops exactly the invisible
// characters a model reads and a reviewer does not: C0 and C1 controls
// (tab and newline kept), the Unicode tag block and the selected format
// characters. Everything else, ordinary text and printable Unicode, is
// kept unchanged.

import { describe, expect, test } from "bun:test";
import { cleanText } from "../../../src/server/skills/clean.ts";

describe("cleanText", () => {
  test("keeps tab and newline but drops the other C0 controls", () => {
    expect(cleanText("a\tb\nc")).toBe("a\tb\nc");
    // \x00 NUL, \x07 BELL, \x08 BS, \x0b VT, \x0c FF, \x1f US, \r CR
    expect(cleanText("a\x00b\x07c\x08d\x0be\x0cf\x1fg\rh")).toBe("abcdefgh");
  });

  test("drops the C1 controls U+0080 to U+009F, DEL included", () => {
    expect(cleanText("a\x7fb")).toBe("ab");
    expect(cleanText("a\u0080b\u009fc")).toBe("abc");
    // U+00A0 no-break space is not a control and is kept
    expect(cleanText("a\u00a0b")).toBe("a\u00a0b");
  });

  test("drops the format characters U+200B..U+200F and U+2060..U+2064", () => {
    // zero-width space, ZWNJ, ZWJ, LRM, RLM
    expect(cleanText("a\u200bb\u200cc\u200dd\u200ee\u200ff")).toBe("abcdef");
    // word joiner U+2060 through U+2064
    expect(cleanText("a\u2060b\u2061c\u2062d\u2063e\u2064f")).toBe("abcdef");
    // the edges just outside the ranges are kept
    expect(cleanText("\u200a\u2010\u205f\u2065")).toBe(
      "\u200a\u2010\u205f\u2065",
    );
  });

  test("drops the Unicode tag block U+E0000 to U+E007F by code point", () => {
    const tags = "\u{E0000}\u{E0001}\u{E0041}\u{E007F}";
    expect(cleanText(`start${tags}end`)).toBe("startend");
    // an astral character just past the tag block is kept whole
    expect(cleanText("x\u{E0080}y")).toBe("x\u{E0080}y");
    // an ordinary astral character (an emoji) survives as one code point
    expect(cleanText("hi \u{1F600}!")).toBe("hi \u{1F600}!");
  });

  test("leaves ordinary and printable Unicode text untouched", () => {
    const text = "Flux CD & Timoni: a guide.\nSecond line, dash.";
    expect(cleanText(text)).toBe(text);
  });
});
