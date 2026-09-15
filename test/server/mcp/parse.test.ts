// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  parseCreate,
  parsePatch,
  parsePatterns,
  parseTimeout,
  parseUrl,
} from "../../../src/server/mcp/parse.ts";

const createBody = () => ({
  name: "cluster",
  url: "https://hands.test/mcp/",
  keyName: null,
  read: true,
  write: false,
  instructionsOn: true,
  timeoutMs: null,
  readPatterns: ["get_*"],
  writePatterns: [],
  excludedPatterns: ["delete_*"],
});

describe("MCP request parsing", () => {
  test("accepts a complete create body", () => {
    expect(parseCreate(createBody())).toEqual(createBody());
  });

  test("validates patterns and repeats", () => {
    expect(parsePatterns(["*"], "patterns")).toEqual(["*"]);
    expect(() => parsePatterns(["a*b"], "patterns")).toThrow("invalid pattern");
    expect(() => parsePatterns([""], "patterns")).toThrow("invalid pattern");
    expect(() => parsePatterns(["get", "get"], "patterns")).toThrow(
      "repeated pattern",
    );
    expect(() =>
      parsePatterns(
        Array.from({ length: 51 }, (_, index) => `tool-${index}`),
        "patterns",
      ),
    ).toThrow("too many patterns");
  });

  test("validates the server name", () => {
    expect(() => parseCreate({ ...createBody(), name: "bad_name" })).toThrow(
      "name is invalid",
    );
    expect(() =>
      parseCreate({ ...createBody(), name: "a".repeat(25) }),
    ).toThrow("name is invalid");
  });

  test("keeps endpoint spelling and rejects unsafe URLs", () => {
    expect(parseUrl("https://hands.test/mcp/?set=read")).toBe(
      "https://hands.test/mcp/?set=read",
    );
    expect(() => parseUrl("https://user@hands.test/mcp")).toThrow("user info");
    expect(() => parseUrl("https://hands.test/mcp#part")).toThrow("fragment");
    expect(() => parseUrl("ftp://hands.test/mcp")).toThrow("http or https");
    expect(() => parseUrl(`https://hands.test/${"x".repeat(2049)}`)).toThrow(
      "too long",
    );
  });

  test("uses the provider key-name rules, then the mcp- prefix", () => {
    expect(parsePatch({ keyName: "mcp-hands" })).toEqual({
      keyName: "mcp-hands",
    });
    expect(parsePatch({ keyName: null })).toEqual({ keyName: null });
    expect(() => parsePatch({ keyName: "Bad_Key" })).toThrow(
      "lowercase letters",
    );
    expect(() => parsePatch({ keyName: "admin" })).toThrow(
      "not a provider key",
    );
    expect(() => parsePatch({ keyName: "hands-key" })).toThrow(
      "must start with mcp-",
    );
  });

  test("validates the timeout floor, ceiling, null and integers", () => {
    expect(parseTimeout(null)).toBeNull();
    expect(parseTimeout(1_000)).toBe(1_000);
    expect(parseTimeout(3_600_000)).toBe(3_600_000);
    expect(() => parseTimeout(999)).toThrow("timeoutMs");
    expect(() => parseTimeout(3_600_001)).toThrow("timeoutMs");
    expect(() => parseTimeout(1_000.5)).toThrow("timeoutMs");
  });

  test("refuses empty, named and mixed patches", () => {
    expect(() => parsePatch({})).toThrow("must not be empty");
    expect(() => parsePatch({ name: "other" })).toThrow("unknown field name");
    expect(() => parsePatch({ url: "https://hands.test", read: true })).toThrow(
      "changed alone",
    );
  });
});
