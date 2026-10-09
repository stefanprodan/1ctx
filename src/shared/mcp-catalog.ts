// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The catalog of discovery mode and the mode the token cap picks, read
// by the server's offer and the Directory. Environment neutral: no Bun,
// no DOM, no packages.

import type { PromptServer } from "./mcp.ts";
import { escapeText } from "./skills.ts";
import { firstSentence, MAX_CATALOG_LINE } from "./text.ts";
import { isRecord, type McpMode } from "./words.ts";

// decision 19: the catalog of discovery mode, and the mode a send runs in
export const MCP_CATALOG_FROM_TOKENS = 6000;
export const MAX_CATALOG = 16_000;
export const CATALOG_LEAD =
  "The following MCP tools are available through two tools: call mcp_describe with a tool's name to get its arguments, then mcp_call with the name and the arguments. mcp_describe gives the type and meaning of each argument.";
// what each tier's lines hold, said after the lead, so a model reading
// a partial catalog knows to describe before it calls
export const CATALOG_OPENINGS = [
  "COMPLETE: every tool, with its arguments and what it does. A ? after an argument marks it optional.",
  "PARTIAL: every tool with its arguments; mcp_describe gives what each does. A ? after an argument marks it optional.",
  "PARTIAL: every tool name; mcp_describe gives arguments and what each does.",
] as const;
const CATALOG_CLOSE = "</available_mcp_tools>";

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

type CatalogTool = { name: string; args: string; description: string };

// a line per tier, longest first
const TIER_LINES: ((tool: CatalogTool) => string)[] = [
  (t) =>
    `${t.name}${t.args}: ${escapeText(firstSentence(t.description, MAX_CATALOG_LINE))}`,
  (t) => `${t.name}${t.args}`,
  (t) => t.name,
];

// Every offered tool, under its server's header in the order given, at
// the first tier whose whole text fits MAX_CATALOG: the cap shortens
// lines and never removes a tool, since the catalog is the only list of
// names the model gets. Tier 3 is printed over the cap rather than
// dropping anything; overCap tells the caller to say so.
export function mcpCatalog(servers: PromptServer[]): {
  text: string;
  overCap: boolean;
} {
  const listed = servers.filter((server) => server.tools.length > 0);
  if (listed.length === 0) return { text: "", overCap: false };
  const parsed = listed.map((server) => {
    const count = server.tools.length;
    return {
      header: `${server.name} (${count} ${count === 1 ? "tool" : "tools"}):\n`,
      tools: server.tools.map(
        (t): CatalogTool => ({
          name: t.wireName,
          args: catalogArguments(t.schemaJson),
          description: t.description,
        }),
      ),
    };
  });
  let text = "";
  for (const [tier, line] of TIER_LINES.entries()) {
    const body = parsed
      .map((s) => s.header + s.tools.map((t) => `${line(t)}\n`).join(""))
      .join("");
    text = `${CATALOG_LEAD}\n${CATALOG_OPENINGS[tier]}\n\n<available_mcp_tools>\n${body}${CATALOG_CLOSE}`;
    if (text.length <= MAX_CATALOG) return { text, overCap: false };
  }
  return { text, overCap: true };
}

// tokens: the offered MCP schemas on the wire, counted by the server
export function resolveMode(mode: McpMode, tokens: number): "all" | "catalog" {
  if (mode !== "auto") return mode;
  return tokens <= MCP_CATALOG_FROM_TOKENS ? "all" : "catalog";
}
