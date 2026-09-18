// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  kindOf,
  normalizeKnowledgePath,
  splitRawPath,
  textFromBytes,
  textFromString,
} from "../../src/shared/knowledge.ts";
import { isKnowledgeName } from "../../src/shared/words.ts";
import textFixtures from "../fixtures/knowledge/text.json";

describe("raw knowledge paths", () => {
  test.each([
    ["", []],
    ["/./\\//.\\", []],
    ["./docs//./Run Book.md", ["docs", "Run Book.md"]],
    ["\\docs\\.\\nested/file.md\\", ["docs", "nested", "file.md"]],
    ["../docs/..\\file.md", ["..", "docs", "..", "file.md"]],
    ["./__MACOSX/x", ["__MACOSX", "x"]],
    ["a\\._b", ["a", "._b"]],
    [" ./．/ Café \u200b", [" .", "．", " Café \u200b"]],
  ] as const)("splits %j without repairing raw segments", (raw, parts) => {
    expect(splitRawPath(raw)).toEqual([...parts]);
  });
});

describe("normalized knowledge paths", () => {
  test("defaults to a file path when options are omitted", () => {
    expect(normalizeKnowledgePath("My Docs/On Call.md")).toEqual({
      ok: true,
      name: "my-docs/on-call.md",
    });
    expect(normalizeKnowledgePath("My Docs/On Call.md", {})).toEqual({
      ok: true,
      name: "my-docs/on-call.md",
    });
    expect(normalizeKnowledgePath("")).toEqual({
      ok: false,
      reason: "bad-name",
    });
    expect(normalizeKnowledgePath("", {})).toEqual({
      ok: false,
      reason: "bad-name",
    });
  });

  test.each([
    ["Q3 Plan (Final).md", "q3-plan-final.md"],
    ["My Docs/On Call.md", "my-docs/on-call.md"],
    ["README.md", "readme.md"],
    ["./My Docs\\./On Call.md//", "my-docs/on-call.md"],
    ["/Absolute/File.md", "absolute/file.md"],
    ["café.md", "cafe.md"],
    ["Cafe\u0301.md", "cafe.md"],
    ["naïve Straße.md", "naive-strasse.md"],
    ["Ærø.md", "aero.md"],
    ["ﬀ ﬁ ﬂ ﬃ ﬄ.md", "ff-fi-fl-ffi-ffl.md"],
    ["Ｆｕｌｌ Ｗｉｄｔｈ．ｍｄ", "full-width.md"],
    ["ＦＯＯ／ＢＡＲ.md", "foo-bar.md"],
    ["A\u0301\u1ab0\u1dc0\u20d0\ufe20B.md", "ab.md"],
    ["  !!Hello?! *** World!! . md?  ", "hello-world.md"],
    ["---A----B---.---md---", "a-b.md"],
    ["A-.-B.md", "a.b.md"],
    ["a.-.-.b", "a...b"],
    [".ENV", ".env"],
    ["_A_B_", "_a_b_"],
    ["...", "..."],
    ["日本語.md", ".md"],
    ["1 ２ ③.md", "1-2-3.md"],
  ])("normalizes %j to %j", (raw, name) => {
    for (const folder of [false, true]) {
      expect(normalizeKnowledgePath(raw, { folder })).toEqual({
        ok: true,
        name,
      });
    }
    expect(isKnowledgeName(name)).toBe(true);
  });

  test.each([
    ["ß", "ss"],
    ["ẞ", "ss"],
    ["æ", "ae"],
    ["Æ", "ae"],
    ["œ", "oe"],
    ["Œ", "oe"],
    ["ø", "o"],
    ["Ø", "o"],
    ["ł", "l"],
    ["Ł", "l"],
    ["đ", "d"],
    ["Đ", "d"],
    ["ð", "d"],
    ["Ð", "d"],
    ["þ", "th"],
    ["Þ", "th"],
    ["ı", "i"],
    ["I", "i"],
    ["İ", "i"],
  ])("transliterates Latin %s to %s", (raw, name) => {
    expect(normalizeKnowledgePath(raw, { folder: false })).toEqual({
      ok: true,
      name,
    });
  });

  test.each([
    0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b,
    0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066,
    0x2067, 0x2068, 0x2069, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f,
    0xfeff,
  ])("drops zero-width and bidirectional mark %i", (code) => {
    expect(
      normalizeKnowledgePath(`A${String.fromCodePoint(code)}B.md`, {
        folder: false,
      }),
    ).toEqual({ ok: true, name: "ab.md" });
  });

  test.each([
    ["../a", "outside"],
    ["a\\..\\b", "outside"],
    ["a/../b", "outside"],
    ["..", "outside"],
    ["日本語/../b", "outside"],
    ["日本語", "no-letters"],
    ["valid/日本語/file.md", "no-letters"],
    [" !?$ ", "no-letters"],
    ["---", "no-letters"],
    ["\u0301\u200b\u202e", "no-letters"],
    [".-.", "bad-name"],
    ["-.-", "bad-name"],
    ["．", "bad-name"],
    ["．．", "bad-name"],
    ["safe/．．/file.md", "bad-name"],
    [". .", "bad-name"],
  ] as const)("refuses %j as %s", (raw, reason) => {
    for (const folder of [false, true]) {
      expect(normalizeKnowledgePath(raw, { folder })).toEqual({
        ok: false,
        reason,
      });
    }
  });

  test.each(["", ".", "/", "\\", "./\\//."])(
    "allows %j as the empty root only for a folder",
    (raw) => {
      expect(normalizeKnowledgePath(raw, { folder: true })).toEqual({
        ok: true,
        name: "",
      });
      expect(normalizeKnowledgePath(raw, { folder: false })).toEqual({
        ok: false,
        reason: "bad-name",
      });
    },
  );

  test("enforces normalized segment, joined-name and depth limits", () => {
    const maxName = ["a".repeat(80), "b".repeat(80), "c".repeat(38)].join("/");
    const eight = Array(8).fill("a").join("/");
    expect(maxName.length).toBe(200);
    for (const folder of [false, true]) {
      for (const raw of ["A".repeat(80), "ß".repeat(40), maxName, eight]) {
        const name = raw.replace(/ß/g, "ss").toLowerCase();
        expect(normalizeKnowledgePath(raw, { folder })).toEqual({
          ok: true,
          name,
        });
        expect(isKnowledgeName(name)).toBe(true);
      }
      for (const raw of [
        "a".repeat(81),
        "ß".repeat(41),
        `${maxName}d`,
        `${eight}/a`,
      ]) {
        expect(normalizeKnowledgePath(raw, { folder })).toEqual({
          ok: false,
          reason: "too-long",
        });
      }
    }
  });

  test("checks the normalized length, never truncating raw text", () => {
    expect(
      normalizeKnowledgePath(`${"A\u0301".repeat(80)}!!!`, { folder: false }),
    ).toEqual({ ok: true, name: "a".repeat(80) });
    expect(
      normalizeKnowledgePath(`${"A".repeat(80)}B`, { folder: false }),
    ).toEqual({ ok: false, reason: "too-long" });
  });

  test("keeps the stored-name rule case-sensitive and unchanged", () => {
    expect(isKnowledgeName("README.md")).toBe(true);
    expect(isKnowledgeName("readme.md")).toBe(true);
    expect(normalizeKnowledgePath("README.md", { folder: false })).toEqual({
      ok: true,
      name: "readme.md",
    });
  });

  test("generated successful paths are valid and normalization is idempotent", () => {
    let seed = 0x1c7a2026;
    const next = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    const tokens = [
      ..."AbCxyz019._- /\\",
      "ß",
      "Æ",
      "ø",
      "Œ",
      "Ł",
      "Þ",
      "İ",
      "café",
      "日本語",
      "ﬃ",
      "．",
      "Ａ",
      "／",
      "\u0301",
      "\u200b",
      "\u202e",
      "\u2069",
      "\ufeff",
      "\0",
      "\ud800",
      "😀",
      "?!",
    ];
    let successes = 0;
    let failures = 0;
    for (let sample = 0; sample < 2048; sample++) {
      const length = next(300);
      let raw = "";
      for (let at = 0; at < length; at++) {
        raw +=
          next(8) === 0
            ? String.fromCodePoint(next(0x110000))
            : tokens[next(tokens.length)];
      }
      for (const folder of [false, true]) {
        const result = normalizeKnowledgePath(raw, { folder });
        if (!result.ok) {
          failures++;
          continue;
        }
        successes++;
        expect(
          isKnowledgeName(result.name) || (folder && result.name === ""),
        ).toBe(true);
        expect(normalizeKnowledgePath(result.name, { folder })).toEqual(result);
      }
    }
    expect(successes).toBeGreaterThan(100);
    expect(failures).toBeGreaterThan(100);
  });
});

describe("knowledge text", () => {
  test.each(textFixtures)("$name", (fixture) => {
    const readers: (() => string)[] = [];
    if (fixture.bytes !== undefined) {
      readers.push(() => textFromBytes(Uint8Array.from(fixture.bytes!)));
    }
    if (fixture.text !== undefined) {
      readers.push(() => textFromString(fixture.text!));
    }
    for (const read of readers) {
      if (fixture.invalid) expect(read).toThrow("not a text file");
      else expect(read()).toBe(fixture.expected!);
    }
  });

  test("preserves whitespace, newlines and Unicode text", () => {
    for (const text of [" \t\r\n", "Café 日本語 😀\r\n", "a\ufeffb"]) {
      expect(textFromString(text)).toBe(text);
      expect(textFromBytes(new TextEncoder().encode(text))).toBe(text);
    }
  });

  test.each([
    { name: "NUL", tail: [0] },
    { name: "replacement character", tail: [0xef, 0xbf, 0xbd] },
    { name: "invalid continuation", tail: [0xc3, 0x28] },
    { name: "incomplete sequence", tail: [0xe2, 0x82] },
    { name: "unexpected continuation", tail: [0x80] },
    { name: "surrogate", tail: [0xed, 0xa0, 0x80] },
  ])("refuses $name past a 512-byte prefix", ({ tail }) => {
    const bytes = new Uint8Array(1024 + tail.length).fill(0x61);
    bytes.set(tail, 1024);
    expect(() => textFromBytes(bytes)).toThrow("not a text file");
  });

  test("decodes just the supplied byte view", () => {
    const bytes = new Uint8Array([0xff, 0x68, 0x69, 0]);
    expect(textFromBytes(bytes.subarray(1, 3))).toBe("hi");
  });

  test("reports kinds independently of case and parent dots", () => {
    expect(kindOf("docs/runbook.MD")).toBe("md");
    expect(kindOf(".gitignore")).toBe("");
    expect(kindOf("Makefile")).toBe("");
    expect(kindOf("dir.with.dot/main.go")).toBe("go");
  });
});
