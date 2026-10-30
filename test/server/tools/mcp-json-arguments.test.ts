// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { ToolError } from "../../../src/server/lib/errors.ts";
import type {
  OfferedMcpTool,
  OfferedServer,
} from "../../../src/server/mcp/index.ts";
import { validateArguments } from "../../../src/server/mcp/validate.ts";
import {
  checkMcpArguments,
  resolveMcpCall,
} from "../../../src/server/tools/builtin/mcp.ts";

const schema = {
  type: "object",
  properties: {
    symbols: { type: "array", items: { type: "string" }, minItems: 1 },
    range: {
      type: "object",
      properties: { from: { type: "string" } },
      required: ["from"],
    },
    query: { type: "string" },
    either: { type: ["string", "array"] },
    fields: { type: ["null", "array"], items: { type: "string" } },
    anyway: { anyOf: [{ type: "string" }, { type: "array" }] },
    limit: { type: "number" },
  },
  required: ["symbols"],
  additionalProperties: false,
};

const tool = {
  wireName: "mcp__markets__quote",
  inputSchema: schema,
} as unknown as OfferedMcpTool;

const check = (input: Record<string, unknown>) =>
  checkMcpArguments(tool, input, validateArguments);

const failure = (input: Record<string, unknown>): string => {
  try {
    check(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    return (error as Error).message;
  }
  throw new Error("the call passed");
};

describe("checkMcpArguments", () => {
  test("sends a valid call as written", () => {
    const input = { symbols: ["NVDA"], query: '["kept as text"]' };
    expect(check(input)).toBe(input);
  });

  test("parses a list written as JSON text", () => {
    expect(check({ symbols: '["NVDA","TSM"]' })).toEqual({
      symbols: ["NVDA", "TSM"],
    });
  });

  test("parses an object written as JSON text, spaces around it", () => {
    expect(
      check({ symbols: ["NVDA"], range: ' {"from":"2026-10-30"} ' }),
    ).toEqual({ symbols: ["NVDA"], range: { from: "2026-10-30" } });
  });

  test("parses a nullable list, and leaves null as sent", () => {
    expect(check({ symbols: ["NVDA"], fields: '["name"]' })).toEqual({
      symbols: ["NVDA"],
      fields: ["name"],
    });
    const nulled = { symbols: ["NVDA"], fields: null };
    expect(check(nulled)).toBe(nulled);
    expect(failure({ symbols: ["NVDA"], fields: "null" })).toContain(
      "must be null,array",
    );
  });

  test("never parses a property that also takes a string", () => {
    expect(failure({ symbols: "NVDA", either: "[1]" })).toBe(
      failure({ symbols: "NVDA" }),
    );
    // the string is valid there, so only the broken list is repaired
    expect(
      check({ symbols: '["NVDA"]', either: "[1]", anyway: "[2]" }),
    ).toEqual({ symbols: ["NVDA"], either: "[1]", anyway: "[2]" });
  });

  test("keeps the first error when the repair still fails", () => {
    const first = failure({ symbols: '["NVDA"]', limit: "ten" });
    expect(first).toContain("arguments for mcp__markets__quote are invalid");
    expect(first).toContain("must be array");
    expect(failure({ symbols: "[]" })).toContain("must be array");
  });

  test("leaves text that is not JSON, or JSON of the wrong kind", () => {
    expect(failure({ symbols: "[NVDA" })).toContain("must be array");
    expect(failure({ symbols: "NVDA" })).toContain("must be array");
    expect(failure({ symbols: "1" })).toContain("must be array");
  });

  test("never adds an unknown property", () => {
    expect(failure({ symbols: '["NVDA"]', extra: '["x"]' })).toContain(
      "unknown property 'extra'",
    );
  });
});

describe("resolveMcpCall", () => {
  const servers = [{ tools: [tool] }] as unknown as OfferedServer[];

  test("sends the repaired arguments", () => {
    const call = {
      id: "c1",
      name: "mcp_call",
      arguments: JSON.stringify({
        name: "mcp__markets__quote",
        arguments: { symbols: '["NVDA","TSM"]' },
      }),
    };
    const target = resolveMcpCall(servers, call, validateArguments);
    expect(target.name).toBe("mcp__markets__quote");
    expect(JSON.parse(target.arguments)).toEqual({ symbols: ["NVDA", "TSM"] });
  });
});
