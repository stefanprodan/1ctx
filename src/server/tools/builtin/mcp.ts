// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { toolArguments } from "../../../shared/contracts/tool.ts";
import { isRecord } from "../../../shared/words.ts";
import { ToolError } from "../../lib/errors.ts";
import type { Mcp, OfferedMcpTool, OfferedServer } from "../../mcp/index.ts";
import type { ToolCall } from "../../providers/index.ts";
import { parsedArgs } from "../registry.ts";
import type { Tool } from "../types.ts";

function flat(servers: OfferedServer[]): OfferedMcpTool[] {
  return servers.flatMap((server) => server.tools);
}

function named(servers: OfferedServer[], value: unknown): OfferedMcpTool {
  if (typeof value !== "string" || value === "") {
    throw new Error("name must be an available MCP tool");
  }
  const tool = flat(servers).find((item) => item.wireName === value);
  if (tool === undefined) {
    throw new ToolError(
      `MCP tool ${value} is not available; use a name from the available MCP tools`,
      "MCP tool not available",
    );
  }
  return tool;
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("arguments must be an object");
  return value;
}

// only an mcp_call reaches here
function outer(call: ToolCall): Record<string, unknown> {
  return parsedArgs(call, "arguments must be an object");
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
  const args = toolArguments(call.arguments) ?? call.arguments;
  return {
    ...call,
    name: "mcp_call",
    arguments: JSON.stringify({ name: call.name, arguments: args }),
  };
}

// a schema property that takes no string, so JSON text in it is
// never what the tool wants
function takesNoString(property: unknown): boolean {
  if (!isRecord(property)) return false;
  const type = property.type;
  if (type === "array" || type === "object") return true;
  // null may share the list: parsed text is never null
  return (
    Array.isArray(type) &&
    type.some((item) => item === "array" || item === "object") &&
    type.every(
      (item) => item === "array" || item === "object" || item === "null",
    )
  );
}

// a model may write a list or object as JSON text; parsed only where
// the schema takes no string, null when nothing changed
function parsedJsonText(
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  let out: Record<string, unknown> | null = null;
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== "string") continue;
    if (!Object.hasOwn(properties, name)) continue;
    if (!takesNoString(properties[name])) continue;
    const text = value.trim();
    if (!text.startsWith("[") && !text.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    out ??= { ...input };
    out[name] = parsed;
  }
  return out;
}

// both call paths refuse before anything goes out, in the same words.
// Only a call that fails is repaired, and only if it then passes, so a
// valid call is sent as written
export function checkMcpArguments(
  tool: OfferedMcpTool,
  input: Record<string, unknown>,
  validate: Mcp["validateArguments"],
): Record<string, unknown> {
  const error = validate(tool.inputSchema, input);
  if (error === null) return input;
  const repaired = parsedJsonText(tool.inputSchema, input);
  if (repaired !== null && validate(tool.inputSchema, repaired) === null) {
    return repaired;
  }
  throw new ToolError(
    `arguments for ${tool.wireName} are invalid: ${error}`,
    "MCP arguments invalid",
  );
}

export function resolveMcpCall(
  servers: OfferedServer[],
  call: ToolCall,
  validate: Mcp["validateArguments"],
): ToolCall {
  const args = outer(call);
  const tool = named(servers, args.name);
  const input = checkMcpArguments(tool, object(args.arguments), validate);
  return { ...call, name: tool.wireName, arguments: JSON.stringify(input) };
}

export function makeMcpCatalogTools(servers: OfferedServer[]): Tool[] {
  if (servers.length === 0) return [];
  // no enum: the catalog lists the names, and named() refuses the rest
  const name = {
    type: "string",
    description: "A tool name from the available MCP tools above.",
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
        // minified: the result stays in history, and indentation adds
        // tokens without meaning
        const schema = JSON.stringify(tool.wireInputSchema);
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
