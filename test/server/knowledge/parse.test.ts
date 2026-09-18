// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  parseCreate,
  parseId,
  parseName,
  parseReplace,
} from "../../../src/server/knowledge/parse.ts";
import fixtures from "../../fixtures/knowledge/text.json";
import { refuses } from "../../helpers/refuses.ts";

describe("create knowledge", () => {
  refuses(
    [
      null,
      [],
      "text",
      {},
      { name: "ok" },
      { text: "ok" },
      { name: "ok", text: null },
      { name: "ok", text: 1 },
      { name: "ok", text: "", revision: 1 },
      ...fixtures
        .filter((row) => row.invalid && row.text !== undefined)
        .map((row) => ({ name: "ok", text: row.text })),
    ],
    parseCreate,
  );
  test("keeps names, whitespace and line endings, dropping only the BOM", () => {
    expect(parseCreate({ name: "Docs/X.MD", text: "\ufeff \t\r\n" })).toEqual({
      name: "Docs/X.MD",
      text: " \t\r\n",
    });
    expect(parseCreate({ name: ".gitignore", text: "" }).text).toBe("");
  });
});

describe("knowledge names", () => {
  refuses(
    [
      undefined,
      null,
      1,
      "",
      ".",
      "..",
      "a/../b",
      "a/./b",
      "/a",
      "a/",
      "a//b",
      "a\\b",
      "with space",
      "a\nb",
      "a%2fb",
      "<name>",
      "\u00e9",
      "a".repeat(81),
      Array(9).fill("a").join("/"),
      `${"a".repeat(80)}/${"b".repeat(80)}/${"c".repeat(39)}`,
    ],
    parseName,
  );
  test("accepts the exact path boundaries", () => {
    for (const name of [
      "a",
      "a".repeat(80),
      Array(8).fill("a").join("/"),
      `${"a".repeat(80)}/${"b".repeat(80)}/${"c".repeat(38)}`,
    ])
      expect(parseName(name)).toBe(name);
  });
});

describe("replace knowledge", () => {
  refuses(
    [
      null,
      [],
      {},
      { text: "ok" },
      { revision: 1 },
      ...[0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1].map(
        (revision) => ({ text: "ok", revision }),
      ),
      { text: "ok", revision: 1, name: "renamed" },
      { text: "\ud800", revision: 1 },
    ],
    parseReplace,
  );
  test("takes a positive revision and empty text", () => {
    expect(parseReplace({ text: "", revision: 2 })).toEqual({
      text: "",
      revision: 2,
    });
  });
});

describe("knowledge ids", () => {
  refuses(
    [null, 1, "", "short", "A".repeat(12), "x".repeat(13), "../secret"],
    (value) => parseId(value, "fileId"),
  );
  test("accepts a stored id", () => {
    expect(parseId("a1b2c3d4e5f6", "versionId")).toBe("a1b2c3d4e5f6");
  });
});
