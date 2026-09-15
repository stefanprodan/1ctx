// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pure rules of MCP, shared by the server and the page so the
// admin's preview is the bytes a send carries: the wire name, the
// split of a server's tools by patterns, the lean schema the wire
// gets, the instructions block and the digest of what a send offered,
// the catalog of discovery mode and the mode the token cap picks.
// Environment neutral: no Bun, no DOM, no packages. The hash is an
// argument, so the server passes Bun's and the page a stub.

import type { AgentServer } from "./contracts/mcp.ts";
import { escapeText } from "./skills.ts";
import type { McpMode } from "./words.ts";

// the wire name mcp__<server>__<tool>, in the OpenAI rule, else null
export const MAX_WIRE_NAME = 64;
const WIRE_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const WIRE_PREFIX = "mcp__";

export function wireName(server: string, tool: string): string | null {
  const name = `${WIRE_PREFIX}${server}__${tool}`;
  return WIRE_RE.test(name) ? name : null;
}

// the server and the tool a wire name carries; the server name holds
// no underscore, so the first `__` after the prefix ends it
export function splitWireName(
  name: string,
): { server: string; tool: string } | null {
  if (!name.startsWith(WIRE_PREFIX)) return null;
  const rest = name.slice(WIRE_PREFIX.length);
  const at = rest.indexOf("__");
  if (at <= 0 || at + 2 >= rest.length) return null;
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

// the split, in one order: unusable, excluded, read, write
export type ToolSide = "read" | "write" | "excluded" | "unusable";
export type Patterns = {
  read: string[];
  write: string[];
  excluded: string[];
};

function matches(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

function matchesAny(patterns: string[], name: string): boolean {
  return patterns.some((pattern) => matches(pattern, name));
}

export function classify(
  server: string,
  tools: { name: string; unusable: string | null }[],
  patterns: Patterns,
): Map<string, ToolSide> {
  const out = new Map<string, ToolSide>();
  for (const tool of tools) {
    if (tool.unusable !== null || wireName(server, tool.name) === null) {
      out.set(tool.name, "unusable");
    } else if (matchesAny(patterns.excluded, tool.name)) {
      out.set(tool.name, "excluded");
    } else if (matchesAny(patterns.read, tool.name)) {
      out.set(tool.name, "read");
    } else if (
      patterns.write.length === 0 ||
      matchesAny(patterns.write, tool.name)
    ) {
      out.set(tool.name, "write");
    } else {
      out.set(tool.name, "excluded");
    }
  }
  return out;
}

// the patterns matching no discovered name, unusable ones included, so
// a typo is seen before it is saved
export function unmatched(names: string[], patterns: Patterns): string[] {
  const out: string[] = [];
  for (const list of [patterns.read, patterns.write, patterns.excluded]) {
    for (const pattern of list) {
      if (!out.includes(pattern) && !names.some((n) => matches(pattern, n))) {
        out.push(pattern);
      }
    }
  }
  return out;
}

// a field's text as a list: split on lines, trimmed, no blanks, a
// repeat dropped keeping the first
export function patternLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line !== "" && !out.includes(line)) out.push(line);
  }
  return out;
}

// decision 18: the schema the wire gets. Deterministic: the same
// input gives the same bytes. Drops what the model does not need,
// inlines a local $ref (a cycle keeps it), and never touches the
// names under `properties`, which are the tool's own
export const MAX_WIRE_DESCRIPTION = 1024;
const DROPPED_KEYS = new Set([
  "$schema",
  "title",
  "examples",
  "default",
  "additionalProperties",
]);
const SCHEMA_MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const SCHEMA_LISTS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const SCHEMA_ONES = new Set([
  "items",
  "additionalItems",
  "not",
  "contains",
  "propertyNames",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "unevaluatedItems",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

export function wireDescription(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_WIRE_DESCRIPTION
    ? trimmed
    : trimmed.slice(0, MAX_WIRE_DESCRIPTION);
}

export function wireSchema(schema: unknown): unknown {
  const state = { keptRef: false };
  const out = leanSchema(schema, schema, [], state);
  if (isRecord(out) && !state.keptRef) {
    delete out.$defs;
    delete out.definitions;
  }
  return out;
}

function leanSchema(
  node: unknown,
  root: unknown,
  path: string[],
  state: { keptRef: boolean },
): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => leanSchema(item, root, path, state));
  }
  if (!isRecord(node)) return node;
  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    const target = resolveRef(root, ref);
    if (target !== undefined && isRecord(target) && !path.includes(ref)) {
      const inlined = leanSchema(target, root, [...path, ref], state);
      const rest = leanSchema({ ...node, $ref: undefined }, root, path, state);
      if (isRecord(inlined) && isRecord(rest)) {
        for (const key of Object.keys(rest)) {
          if (rest[key] !== undefined) inlined[key] = rest[key];
        }
      }
      return inlined;
    }
    state.keptRef = true;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value === undefined || DROPPED_KEYS.has(key)) continue;
    if (key === "description" && typeof value === "string") {
      out[key] = wireDescription(value);
    } else if (SCHEMA_MAPS.has(key) && isRecord(value)) {
      const map: Record<string, unknown> = {};
      for (const name of Object.keys(value)) {
        map[name] = leanSchema(value[name], root, path, state);
      }
      out[key] = map;
    } else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) {
      out[key] = value.map((item) => leanSchema(item, root, path, state));
    } else if (SCHEMA_ONES.has(key) || key === "items") {
      out[key] = leanSchema(value, root, path, state);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// the sort of decision 18: by server name, then tool name, so the
// tools array is byte-stable across the sends of a session
export function sortOffered<T extends { wireName: string }>(tools: T[]): T[] {
  return tools.slice().sort((a, b) => a.wireName.localeCompare(b.wireName));
}

// decision 11: the instructions block, and decision 17's digest
export const MAX_SERVER_INSTRUCTIONS = 16_000;
export const MAX_INSTRUCTIONS_BLOCK = 32_000;
// decision 14: the offered schemas of one send, as JSON, in all
export const MAX_SCHEMAS_BYTES = 1024 * 1024;

const BLOCK_TAGS = /<(\/?)(mcp_instructions|server)\b/gi;
const BLOCK_OPEN = "<mcp_instructions>\n";
const BLOCK_CLOSE = "</mcp_instructions>";

// the text, each line indented, inside the server's element; the
// four tags lose their < so a server cannot close its block
export function serverBlock(name: string, instructions: string): string {
  const body = instructions
    .replace(BLOCK_TAGS, "&lt;$1$2")
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `  <server name="${name}">\n${body}\n  </server>\n`;
}

// what one send carries from MCP, from the servers offered to it
export type PromptTool = {
  wireName: string;
  description: string;
  schemaJson: string;
};
export type PromptServer = {
  name: string;
  // null: switch off or none sent
  instructions: string | null;
  tools: PromptTool[];
};
export type McpDigest = Record<
  string,
  { tools: Record<string, string>; instructions: string | null }
>;

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    if (point <= 0x7f) bytes += 1;
    else if (point <= 0x7ff) bytes += 2;
    else if (point <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function schemasBytes(server: PromptServer): number {
  let bytes = 0;
  for (const tool of server.tools) {
    bytes += utf8Bytes(tool.wireName + tool.description + tool.schemaJson);
  }
  return bytes;
}

// servers in name order while they fit: one over the schema cap is
// left out whole and not offered; one over the block cap keeps its
// tools and loses its block
export function promptSnapshot(
  servers: PromptServer[],
  sha256: (text: string) => string,
): {
  text: string;
  included: string[];
  leftForSchemas: string[];
  leftForInstructions: string[];
  digest: McpDigest;
} {
  const sorted = servers.slice().sort((a, b) => a.name.localeCompare(b.name));
  const included: string[] = [];
  const leftForSchemas: string[] = [];
  const leftForInstructions: string[] = [];
  const digest: McpDigest = {};
  let bytes = 0;
  let text = BLOCK_OPEN;
  let blocks = 0;
  for (const server of sorted) {
    const size = schemasBytes(server);
    if (bytes + size > MAX_SCHEMAS_BYTES) {
      leftForSchemas.push(server.name);
      continue;
    }
    bytes += size;
    included.push(server.name);
    const tools: Record<string, string> = {};
    for (const tool of sortOffered(server.tools)) {
      tools[tool.wireName] = sha256(`${tool.description}\n${tool.schemaJson}`);
    }
    let instructions: string | null = null;
    if (server.instructions !== null && server.instructions !== "") {
      const block = serverBlock(server.name, server.instructions);
      if (
        text.length + block.length + BLOCK_CLOSE.length <=
        MAX_INSTRUCTIONS_BLOCK
      ) {
        text += block;
        blocks += 1;
        instructions = sha256(server.instructions);
      } else {
        leftForInstructions.push(server.name);
      }
    }
    digest[server.name] = { tools, instructions };
  }
  return {
    text: blocks === 0 ? "" : text + BLOCK_CLOSE,
    included,
    leftForSchemas,
    leftForInstructions,
    digest,
  };
}

// a server as the page or the server's rows offer it: the summary's
// fields the rule reads, so both sides call the one function
export type OfferableTool = {
  name: string;
  wireName: string | null;
  unusable: string | null;
  description: string;
  schemaJson: string;
};
export type OfferableServer = {
  id: string;
  name: string;
  read: boolean;
  write: boolean;
  instructionsOn: boolean;
  instructions: string;
  readPatterns: string[];
  writePatterns: string[];
  excludedPatterns: string[];
  tools: OfferableTool[];
};

// decision 5: a side on in both switches, at least one usable tool on
// that side; each tool shaped for the wire by decision 18
export function offeredServers(
  servers: OfferableServer[],
  agentServers: AgentServer[],
): PromptServer[] {
  const out: PromptServer[] = [];
  for (const link of agentServers) {
    const server = servers.find((s) => s.id === link.serverId);
    if (server === undefined) continue;
    const read = link.read && server.read;
    const write = link.write && server.write;
    if (!read && !write) continue;
    const sides = classify(server.name, server.tools, {
      read: server.readPatterns,
      write: server.writePatterns,
      excluded: server.excludedPatterns,
    });
    const tools: PromptTool[] = [];
    for (const tool of server.tools) {
      const side = sides.get(tool.name);
      if (tool.wireName === null) continue;
      if (!((side === "read" && read) || (side === "write" && write))) {
        continue;
      }
      let schema: unknown;
      try {
        schema = JSON.parse(tool.schemaJson);
      } catch {
        continue;
      }
      tools.push({
        wireName: tool.wireName,
        description: wireDescription(tool.description),
        schemaJson: JSON.stringify(wireSchema(schema)),
      });
    }
    if (tools.length === 0) continue;
    out.push({
      name: server.name,
      instructions:
        server.instructionsOn && server.instructions !== ""
          ? server.instructions
          : null,
      tools: sortOffered(tools),
    });
  }
  return out;
}

// decision 19: the catalog of discovery mode, and the mode a send runs in
export const MCP_CATALOG_FROM_TOKENS = 6000;
export const MAX_CATALOG = 16_000;
export const MAX_CATALOG_LINE = 160;
export const CATALOG_LEAD =
  "The following MCP tools are available through two tools: call mcp_describe with a tool's name to get its parameters, then mcp_call with the name and the arguments. Each line is a tool's name and what it does.";
const CATALOG_OPEN = `${CATALOG_LEAD}\n\n<available_mcp_tools>\n`;
const CATALOG_CLOSE = "</available_mcp_tools>";

// the first sentence of a description, on one line, cut at the line cap
export function firstSentence(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const end = line.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? line : line.slice(0, end + 1);
  return sentence.length <= MAX_CATALOG_LINE
    ? sentence
    : sentence.slice(0, MAX_CATALOG_LINE);
}

// one line per tool, servers in the order given while they fit; a
// server that does not fit is left out whole with every later one,
// since the enum and the catalog must agree
export function mcpCatalog(servers: PromptServer[]): {
  text: string;
  included: string[];
  leftOut: string[];
} {
  let text = CATALOG_OPEN;
  const included: string[] = [];
  const leftOut: string[] = [];
  for (const server of servers) {
    const lines = server.tools
      .map(
        (t) => `${t.wireName}: ${escapeText(firstSentence(t.description))}\n`,
      )
      .join("");
    if (
      leftOut.length === 0 &&
      text.length + lines.length + CATALOG_CLOSE.length <= MAX_CATALOG
    ) {
      text += lines;
      included.push(server.name);
    } else {
      leftOut.push(server.name);
    }
  }
  if (included.length === 0) return { text: "", included, leftOut };
  return { text: text + CATALOG_CLOSE, included, leftOut };
}

// tokens: the offered MCP schemas on the wire, counted by the server
export function resolveMode(mode: McpMode, tokens: number): "all" | "catalog" {
  if (mode !== "auto") return mode;
  return tokens <= MCP_CATALOG_FROM_TOKENS ? "all" : "catalog";
}
