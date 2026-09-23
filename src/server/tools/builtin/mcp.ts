// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Mcp, OfferedMcpTool, OfferedServer } from "../../mcp/index.ts";
import type { ToolCall } from "../../providers/index.ts";
import type { Tool } from "../types.ts";

function flat(servers: OfferedServer[]): OfferedMcpTool[] {
  return servers.flatMap((server) => server.tools);
}

function named(servers: OfferedServer[], value: unknown): OfferedMcpTool {
  if (typeof value !== "string" || value === "") {
    throw new Error("name must be an available MCP tool");
  }
  const tool = flat(servers).find((item) => item.wireName === value);
  if (tool === undefined) throw new Error(`MCP tool ${value} is not available`);
  return tool;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function outer(call: ToolCall): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(call.arguments === "" ? "{}" : call.arguments);
  } catch {
    throw new Error('invalid JSON arguments for tool "mcp_call"');
  }
  return object(value);
}

export function mcpCallName(
  servers: OfferedServer[],
  call: ToolCall,
): string | null {
  if (call.name !== "mcp_call") return null;
  try {
    return named(servers, outer(call).name).wireName;
  } catch {
    return null;
  }
}

// a catalog tool called by its wire name, as in all mode, becomes the
// mcp_call the prompt teaches, before its row is written, so history
// never names a function the tools array lacks
export function asMcpCall(servers: OfferedServer[], call: ToolCall): ToolCall {
  if (!flat(servers).some((tool) => tool.wireName === call.name)) return call;
  let args: unknown;
  try {
    args = JSON.parse(call.arguments === "" ? "{}" : call.arguments);
  } catch {
    args = call.arguments;
  }
  return {
    ...call,
    name: "mcp_call",
    arguments: JSON.stringify({ name: call.name, arguments: args }),
  };
}

// both call paths refuse before anything goes out, in the same words
export function checkMcpArguments(
  tool: OfferedMcpTool,
  input: Record<string, unknown>,
  validate: Mcp["validateArguments"],
): void {
  const error = validate(tool.inputSchema, input);
  if (error !== null) {
    throw new Error(`arguments for ${tool.wireName} are invalid: ${error}`);
  }
}

export function resolveMcpCall(
  servers: OfferedServer[],
  call: ToolCall,
  validate: Mcp["validateArguments"],
): ToolCall {
  const args = outer(call);
  const tool = named(servers, args.name);
  const input = object(args.arguments);
  checkMcpArguments(tool, input, validate);
  return { ...call, name: tool.wireName, arguments: JSON.stringify(input) };
}

export function makeMcpCatalogTools(servers: OfferedServer[]): Tool[] {
  if (servers.length === 0) return [];
  const names = flat(servers).map((tool) => tool.wireName);
  const name = {
    type: "string",
    enum: names,
    description: "The available MCP tool name.",
  };
  return [
    {
      name: "mcp_describe",
      description:
        "Describe one available MCP tool and return its input schema.",
      parameters: {
        type: "object",
        properties: { name },
        required: ["name"],
        additionalProperties: false,
      },
      async run(args) {
        const tool = named(servers, args.name);
        const schema = JSON.stringify(tool.wireInputSchema, null, 2);
        return `${tool.description}\n\n${schema}`;
      },
    },
    {
      name: "mcp_call",
      description:
        "Call one available MCP tool after reading its schema with mcp_describe.",
      parameters: {
        type: "object",
        properties: {
          name,
          arguments: {
            type: "object",
            description: "Arguments matching the described input schema.",
          },
        },
        required: ["name", "arguments"],
        additionalProperties: false,
      },
      async run() {
        throw new Error("mcp_call was not resolved");
      },
    },
  ];
}
