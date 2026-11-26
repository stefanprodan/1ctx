// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { ToolError } from "../../../src/server/lib/errors.ts";
import type {
  OfferedMcpTool,
  OfferedServer,
} from "../../../src/server/mcp/index.ts";
import {
  describeTools,
  MAX_DESCRIBE_NAMES,
  makeMcpCatalogTools,
} from "../../../src/server/tools/builtin/mcp.ts";

const tool = (wireName: string, description: string): OfferedMcpTool =>
  ({
    wireName,
    description,
    wireInputSchema: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
  }) as unknown as OfferedMcpTool;

const servers = [
  {
    name: "s",
    tools: [tool("mcp__s__a", "Reads a."), tool("mcp__s__b", "Reads b.")],
  },
] as unknown as OfferedServer[];

const SCHEMA =
  '{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}';

const thrown = (value: unknown): Error => {
  try {
    describeTools(servers, value);
  } catch (error) {
    return error as Error;
  }
  throw new Error("the describe passed");
};

describe("mcp_describe", () => {
  test("takes one names list, with no count in the schema", () => {
    const [describeTool] = makeMcpCatalogTools(servers);
    expect(describeTool?.parameters).toEqual({
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "Tool names from the available MCP tools above.",
        },
      },
      required: ["names"],
      additionalProperties: false,
    });
  });

  test("one name answers the description, then the minified schema", () => {
    expect(describeTools(servers, ["mcp__s__a"])).toBe(`Reads a.\n\n${SCHEMA}`);
  });

  test("one name not offered fails the call", () => {
    const error = thrown(["mcp__s__z"]);
    expect(error).toBeInstanceOf(ToolError);
    expect(error.message).toBe(
      "MCP tool mcp__s__z is not available; use a name from the available MCP tools",
    );
  });

  test("several names answer in order, each under its name, a refused one on its own", () => {
    expect(
      describeTools(servers, ["mcp__s__b", "mcp__s__z", "mcp__s__a"]),
    ).toBe(
      [
        `mcp__s__b\nReads b.\n\n${SCHEMA}`,
        "mcp__s__z\nError: MCP tool mcp__s__z is not available; use a name from the available MCP tools",
        `mcp__s__a\nReads a.\n\n${SCHEMA}`,
      ].join("\n\n"),
    );
  });

  test("the count is checked in code", () => {
    const ten = Array.from({ length: MAX_DESCRIBE_NAMES }, () => "mcp__s__a");
    expect(describeTools(servers, ten).split("mcp__s__a\n")).toHaveLength(
      MAX_DESCRIBE_NAMES + 1,
    );
    for (const names of [[], [...ten, "mcp__s__b"]]) {
      const error = thrown(names);
      expect(error).toBeInstanceOf(ToolError);
      expect(error.message).toContain(`1 to ${MAX_DESCRIBE_NAMES} tool names`);
    }
  });

  test("anything but a list of strings is refused", () => {
    for (const value of [undefined, "mcp__s__a", [1], ["mcp__s__a", null]]) {
      expect(thrown(value).message).toBe(
        "names must be a list of available MCP tool names",
      );
    }
  });
});
