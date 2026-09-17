// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  parseCreate,
  parseMcpKeyName,
  parsePatch,
  parsePatterns,
  parseTimeout,
  parseUrl,
} from "../../../src/server/mcp/parse.ts";
import secretNames from "../../fixtures/secrets/names.json";

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

  test("keys must have the mcp kind and a 1 to 48 character body", () => {
    expect(parsePatch({ keyName: "mcp-hands" })).toEqual({
      keyName: "mcp-hands",
    });
    expect(parsePatch({ keyName: null })).toEqual({ keyName: null });
    for (const body of secretNames.validBodies) {
      expect(parseMcpKeyName(`mcp-${body}`)).toBe(`mcp-${body}`);
    }
    for (const name of [
      ...secretNames.invalidBodies.map((body) => `mcp-${body}`),
      ...secretNames.wrongNames,
      "Bad_Key",
      "hands-key",
      "user-admin",
      "provider-router",
      "search-exa",
      undefined,
      1,
      {},
    ]) {
      expect(() => parsePatch({ keyName: name })).toThrow("keyName must");
      expect(() => parseCreate({ ...createBody(), keyName: name })).toThrow(
        "keyName must",
      );
    }
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
