// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { resultText } from "../../../src/server/mcp/result.ts";

describe("MCP result text", () => {
  test("joins text and maps binary and resource content", () => {
    expect(
      resultText({
        content: [
          { type: "text", text: "first" },
          { type: "image", data: "ignored" },
          { type: "audio", data: "ignored" },
          { type: "resource", resource: { text: "resource text" } },
          { type: "resource", resource: { blob: "ignored" } },
          { type: "resource_link", uri: "https://resource.test/item" },
        ],
      }),
    ).toEqual({
      text: [
        "first",
        "[image omitted]",
        "[audio omitted]",
        "resource text",
        "[resource omitted]",
        "https://resource.test/item",
      ].join("\n"),
      isError: false,
    });
  });

  test("uses structured content only without a text part", () => {
    expect(resultText({ structuredContent: { ok: true } }).text).toBe(
      '{"ok":true}',
    );
    expect(
      resultText({
        content: [{ type: "text", text: "plain" }],
        structuredContent: { ignored: true },
      }).text,
    ).toBe("plain");
  });

  test("gives an empty server error its plain fallback", () => {
    expect(resultText({ content: [], isError: true })).toEqual({
      text: "the server returned an error",
      isError: true,
    });
  });
});
