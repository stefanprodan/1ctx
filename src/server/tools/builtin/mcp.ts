// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { toolArguments } from "../../../shared/contracts/tool.ts";
import { WIRE_PREFIX } from "../../../shared/mcp.ts";
import { isRecord } from "../../../shared/words.ts";
import { ToolError } from "../../lib/errors.ts";
import {
  type Mcp,
  NO_OFFER,
  type OfferedMcpTool,
  type OfferedServer,
} from "../../mcp/index.ts";
import type { ToolCall } from "../../providers/index.ts";
import { parsedArgs } from "../registry.ts";
import type { Tool } from "../types.ts";

// what the tools ask of MCP; without a service nothing is offered and a
// call is refused
export type McpPort = Pick<
  Mcp,
  "offered" | "offeredSides" | "switchable" | "call" | "validateArguments"
>;

export const NO_MCP: McpPort = {
  switchable: () => [],
  offered: () => NO_OFFER,
  offeredSides: () => NO_OFFER,
  async call() {
    throw new Error("MCP is not configured");
  },
  validateArguments: () => null,
};

function flat(servers: OfferedServer[]): OfferedMcpTool[] {
  return servers.flatMap((server) => server.tools);
}

// a name as the catalog lists it, or with its mcp__ left off: models that
// skip mcp_describe drop the prefix, and only one offered tool can match
function lookup(tools: OfferedMcpTool[], name: string) {
  return (
    tools.find((item) => item.wireName === name) ??
    (name.startsWith(WIRE_PREFIX)
      ? undefined
      : tools.find((item) => item.wireName === `${WIRE_PREFIX}${name}`))
  );
}

const notAvailable = (name: string) =>
  `MCP tool ${name} is not available; use a name from the available MCP tools`;

function named(servers: OfferedServer[], value: unknown): OfferedMcpTool {
  if (typeof value !== "string" || value === "") {
    throw new Error("name must be an available MCP tool");
  }
  const tool = lookup(flat(servers), value);
  if (tool === undefined) {
    throw new ToolError(notAvailable(value), "MCP tool not available");
  }
  return tool;
}

// the schema carries no minItems or maxItems, as measured, so the count
// is checked here
export const MAX_DESCRIBE_NAMES = 10;

function describedNames(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((n) => typeof n === "string")) {
    throw new Error("names must be a list of available MCP tool names");
  }
  if (value.length === 0 || value.length > MAX_DESCRIBE_NAMES) {
    throw new ToolError(
      `names must hold 1 to ${MAX_DESCRIBE_NAMES} tool names; this call has ${value.length}`,
      "MCP describe names count",
    );
  }
  return value;
}

// minified: the result stays in history, and indentation adds tokens
// without meaning
function described(tool: OfferedMcpTool): string {
  return `${tool.description}\n\n${JSON.stringify(tool.wireInputSchema)}`;
}

// one name answers as it always has, and fails the call when it is not
// offered; several each open with their name, a refused one in its own
// line, so one bad name never costs the others a round
export function describeTools(
  servers: OfferedServer[],
  value: unknown,
): string {
  const names = describedNames(value);
  if (names.length === 1) return described(named(servers, names[0]));
  const tools = flat(servers);
  return names
    .map((name) => {
      const tool = lookup(tools, name);
      return tool === undefined
        ? `${name}\nError: ${notAvailable(name)}`
        : `${tool.wireName}\n${described(tool)}`;
    })
    .join("\n\n");
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
        "Describe one or more available MCP tools and return their input schemas.",
      parameters: {
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
      },
      // a history row from before names keeps its name and never runs
      // again
      async run(args) {
        return describeTools(servers, args.names);
      },
    },
    {
      name: "mcp_call",
      description: "Call one available MCP tool by name with its arguments.",
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
