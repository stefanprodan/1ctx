// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The catalog of discovery mode and the mode the token cap picks,
// shared by the server and the page. Environment neutral: no Bun, no
// DOM, no packages.

import { cutText, type PromptServer } from "./mcp.ts";
import { escapeText } from "./skills.ts";
import { isRecord, type McpMode } from "./words.ts";

// decision 19: the catalog of discovery mode, and the mode a send runs in
export const MCP_CATALOG_FROM_TOKENS = 6000;
export const MAX_CATALOG = 16_000;
export const MAX_CATALOG_LINE = 160;
export const CATALOG_LEAD =
  "The following MCP tools are available through two tools: call mcp_describe with a tool's name to get its parameters, then mcp_call with the name and the arguments. Each line is a tool's name, its arguments and what it does. A ? after an argument marks it optional. mcp_describe gives the type and meaning of each argument.";
const CATALOG_OPEN = `${CATALOG_LEAD}\n\n<available_mcp_tools>\n`;
const CATALOG_CLOSE = "</available_mcp_tools>";

// a period closing `e.g` or `i.e` is no sentence end; nothing else is
// skipped, so two real sentences never merge
const SENTENCE_END = /[.!?](?=\s|$)/g;
const ABBREVIATION = /(?:^|[^\p{L}\p{N}_])(?:e\.g|i\.e)$/iu;

// the first sentence of a description, on one line, cut at the line cap
export function firstSentence(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  let sentence = line;
  for (const end of line.matchAll(SENTENCE_END)) {
    const before = line.slice(0, end.index);
    if (end[0] === "." && ABBREVIATION.test(before)) continue;
    sentence = `${before}${end[0]}`;
    break;
  }
  return cutText(sentence, MAX_CATALOG_LINE);
}

// a server's names are its own: one outside this set could break the
// line's grammar or start a new line
const ARGUMENT_NAME = /^[A-Za-z0-9_.$-]+$/;

// a lean schema's top-level arguments as `(a, b?)`, a name the
// validator demands but `properties` lacks included; empty when the
// arguments live in branches or a reference, so mcp_describe tells
export function catalogArguments(schemaJson: string): string {
  let schema: unknown;
  try {
    schema = JSON.parse(schemaJson);
  } catch {
    return "";
  }
  if (!isRecord(schema)) return "";
  for (const key of ["anyOf", "oneOf", "allOf", "$ref"]) {
    if (schema[key] !== undefined) return "";
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name) => typeof name === "string")
    : [];
  const names = isRecord(schema.properties)
    ? Object.keys(schema.properties)
    : [];
  for (const name of required) {
    if (!names.includes(name)) names.push(name);
  }
  if (!names.every((name) => ARGUMENT_NAME.test(name))) return "";
  const shown = names.map((name) =>
    required.includes(name) ? name : `${name}?`,
  );
  return `(${shown.join(", ")})`;
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
        (t) =>
          `${t.wireName}${catalogArguments(t.schemaJson)}: ${escapeText(firstSentence(t.description))}\n`,
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
