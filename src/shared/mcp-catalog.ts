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
  "The following MCP tools are available through two tools: call mcp_call with a tool's name and its arguments. Call mcp_describe first only when you need an argument's type or meaning; it takes several names at once.";
const TYPES =
  "after a colon come a list's item type ([]) or the allowed values (a|b, or … for a long set)";
// what each tier's lines hold, said after the lead, so a model reading
// a partial catalog knows what mcp_describe adds
export const CATALOG_OPENINGS = [
  `COMPLETE: every tool, with its arguments and what it does. A ? after an argument marks it optional; ${TYPES}.`,
  `PARTIAL: every tool with its arguments; mcp_describe gives what each does. A ? after an argument marks it optional; ${TYPES}.`,
  "PARTIAL: every tool with its arguments; mcp_describe gives what each does. A ? after an argument marks it optional.",
  "PARTIAL: every tool name; mcp_describe gives arguments and what each does.",
] as const;
const CATALOG_CLOSE = "</available_mcp_tools>";

// a server's names are its own: one outside this set could break the
// line's grammar or start a new line. Enum values in a hint obey it too
const ARGUMENT_NAME = /^[A-Za-z0-9_.$-]+$/;
const MAX_HINT_VALUES = 6;
const PLAIN_TYPES = new Set(["string", "number", "integer", "boolean"]);

// a fixed set short enough to list, "" for none
function valuesHint(values: unknown[]): string {
  const words = values.map(String);
  if (words.length === 0 || words.length > MAX_HINT_VALUES) return "";
  return words.every((word) => ARGUMENT_NAME.test(word)) ? words.join("|") : "";
}

// a property's type, only where a guess goes wrong: an array sent as
// one string, an enum in the wrong case. "" leaves the name bare; an
// object stays bare, since its keys cost much and fixed nothing
function argumentHint(property: unknown): string {
  if (!isRecord(property)) return "";
  if (Array.isArray(property.enum)) return valuesHint(property.enum);
  const types = Array.isArray(property.type)
    ? property.type.filter((type) => type !== "null")
    : [property.type];
  if (types.length !== 1 || types[0] !== "array") return "";
  const items = isRecord(property.items) ? property.items : {};
  // a long set is (…)[]: string[] reads as free text, bare as one string
  if (Array.isArray(items.enum)) return `(${valuesHint(items.enum) || "…"})[]`;
  if (items.type === "object" || isRecord(items.properties)) return "object[]";
  if (typeof items.type === "string" && PLAIN_TYPES.has(items.type)) {
    return `${items.type}[]`;
  }
  return "";
}

// a lean schema's top-level arguments as `(a, b?: string[])`, a name
// the validator demands but `properties` lacks included; empty when
// the arguments live in branches or a reference, so mcp_describe tells
function argumentList(schema: unknown, typed: boolean): string {
  if (!isRecord(schema)) return "";
  for (const key of ["anyOf", "oneOf", "allOf", "$ref"]) {
    if (schema[key] !== undefined) return "";
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name) => typeof name === "string")
    : [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const names = Object.keys(properties);
  for (const name of required) {
    if (!names.includes(name)) names.push(name);
  }
  if (!names.every((name) => ARGUMENT_NAME.test(name))) return "";
  const shown = names.map((name) => {
    const base = required.includes(name) ? name : `${name}?`;
    const hint = typed ? argumentHint(properties[name]) : "";
    return hint === "" ? base : `${base}: ${hint}`;
  });
  return `(${shown.join(", ")})`;
}

function parsed(schemaJson: string): unknown {
  try {
    return JSON.parse(schemaJson);
  } catch {
    return null;
  }
}

// typed for tiers 1 and 2, untyped for tier 3
export function catalogArguments(schemaJson: string, typed = true): string {
  return argumentList(parsed(schemaJson), typed);
}

type CatalogTool = {
  name: string;
  typed: string;
  args: string;
  description: string;
};

// a line per tier, longest first: types go before arguments
const TIER_LINES: ((tool: CatalogTool) => string)[] = [
  (t) =>
    `${t.name}${t.typed}: ${escapeText(firstSentence(t.description, MAX_CATALOG_LINE))}`,
  (t) => `${t.name}${t.typed}`,
  (t) => `${t.name}${t.args}`,
  (t) => t.name,
];

// Every offered tool, under its server's header in the order given, at
// the first tier whose whole text fits MAX_CATALOG: the cap shortens
// lines and never removes a tool, since the catalog is the only list of
// names the model gets. Tier 4 is printed over the cap rather than
// dropping anything; overCap tells the caller to say so.
export function mcpCatalog(servers: PromptServer[]): {
  text: string;
  overCap: boolean;
} {
  const listed = servers.filter((server) => server.tools.length > 0);
  if (listed.length === 0) return { text: "", overCap: false };
  const shaped = listed.map((server) => {
    const count = server.tools.length;
    return {
      header: `${server.name} (${count} ${count === 1 ? "tool" : "tools"}):\n`,
      tools: server.tools.map((t): CatalogTool => {
        const schema = parsed(t.schemaJson);
        return {
          name: t.wireName,
          typed: argumentList(schema, true),
          args: argumentList(schema, false),
          description: t.description,
        };
      }),
    };
  });
  let text = "";
  for (const [tier, line] of TIER_LINES.entries()) {
    const body = shaped
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
