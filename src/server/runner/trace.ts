// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Another agent's turn as the building agent reads it: its calls, one
// line each, never their results, reasoning or signatures, so no
// provider sees a call without its result and no model reads a call as
// a finding. Written by code from the stored calls: the same calls read
// by the same tools give the same bytes, so the trace never moves a
// cached prefix.

import type { Message, SavedDocs } from "../../shared/contracts/session.ts";
import type { Offered } from "../tools/index.ts";

export const TRACE_HEADING = "Calls in this turn, results not included:";
// the longest line, its summary cut to fit before the status
export const TRACE_LINE_CHARS = 200;
// the most lines; the rest is one line counting them
export const TRACE_LINES = 30;

export type TraceCall = {
  // the tool that ran: the row's name, an MCP call's wire name
  name: string;
  arguments: string;
  status: Message["status"] | null;
  // the docs a bash call wrote, from its row
  saved: SavedDocs | null;
};

// what the reading agent can call itself: its MCP tools by wire name and
// its skills by name. Every other tool counts as its own: a builtin is
// the chat's, the same for every agent in it
export type Yours = {
  mcp: ReadonlySet<string>;
  skills: ReadonlySet<string>;
};

export function yoursOf(offered: Pick<Offered, "mcp" | "skills">): Yours {
  return {
    mcp: new Set(
      offered.mcp.flatMap((server) => server.tools.map((t) => t.wireName)),
    ),
    skills: new Set(offered.skills.skills.map((skill) => skill.name)),
  };
}

// a display or a catalog lookup, not work: no line and no count
const UNTRACED = new Set(["visualize", "mcp_describe"]);

// the send's calls in order, each paired with its tool row by position
// in its round, as the writer pairs them; a call with no row failed
export function traceCalls(rows: readonly Message[]): TraceCall[] {
  const results = new Map<string, Message[]>();
  for (const row of rows) {
    if (row.kind !== "tool") continue;
    const key = `${row.sendId}:${row.round}`;
    results.set(key, [...(results.get(key) ?? []), row]);
  }
  const out: TraceCall[] = [];
  for (const row of rows) {
    if (row.kind !== "reply" || row.slot !== "work") continue;
    const tools = results.get(`${row.sendId}:${row.round}`) ?? [];
    (row.toolCalls ?? []).forEach((call, index) => {
      if (UNTRACED.has(call.name)) return;
      const result = tools[index];
      const paired = result?.toolCallId === call.id ? result : undefined;
      out.push({
        ...(call.name === "mcp_call"
          ? unwrapped(call.arguments)
          : { name: call.name, arguments: call.arguments }),
        ...(paired?.toolName ? { name: paired.toolName } : {}),
        status: paired?.status ?? null,
        saved: paired?.saved ?? null,
      });
    });
  }
  return out;
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

function parsed(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text === "" ? "{}" : text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// a catalog call names the MCP tool and carries its arguments inside
function unwrapped(text: string): Pick<TraceCall, "name" | "arguments"> {
  const args = parsed(text);
  if (args === null || typeof args.name !== "string") {
    return { name: "mcp_call", arguments: text };
  }
  return {
    name: args.name,
    arguments: JSON.stringify(args.arguments ?? {}),
  };
}

const valueText = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);

// every argument in the order the call gave them
const pairs = (args: Record<string, unknown>) =>
  Object.entries(args)
    .map(([key, value]) => `${key}=${valueText(value)}`)
    .join(" ");

const text = (args: Record<string, unknown>, key: string) =>
  typeof args[key] === "string" ? (args[key] as string) : "";

// what identifies the call: bash's first command line, a search's
// query, a fetch's URL, a path, an MCP tool's arguments, the skill it
// loaded, which a summoned agent may lack; a memory edit by its action
// and topic, never its text
export function summary(call: Pick<TraceCall, "name" | "arguments">): string {
  const args = parsed(call.arguments);
  if (args === null) return flat(call.arguments);
  switch (call.name) {
    case "bash":
      return flat(text(args, "command").split("\n", 1)[0] ?? "");
    case "websearch":
      return flat(text(args, "query"));
    case "webfetch":
      return flat(text(args, "url"));
    case "skill":
    case "skill_file":
      return flat(text(args, "name"));
    case "memory_edit":
      return flat(
        [
          `action=${text(args, "action")}`,
          ...(text(args, "topic") === ""
            ? []
            : [`topic=${text(args, "topic")}`]),
        ].join(" "),
      );
  }
  if (call.name.startsWith("mcp__")) return flat(pairs(args));
  if (typeof args.path === "string") return flat(args.path);
  return flat(pairs(args));
}

// cut at a code point, never inside a surrogate pair
function cut(value: string, chars: number): string {
  if (value.length <= chars) return value;
  if (chars <= 1) return "";
  let end = chars - 1;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${value.slice(0, end)}…`;
}

// the reading agent lacks the tool: another agent's MCP tool or skill
function foreign(
  call: Pick<TraceCall, "name" | "arguments">,
  yours: Yours,
): boolean {
  if (call.name.startsWith("mcp__")) return !yours.mcp.has(call.name);
  if (call.name !== "skill" && call.name !== "skill_file") return false;
  return !yours.skills.has(text(parsed(call.arguments) ?? {}, "name"));
}

export const NOT_YOURS = " (not your tool)";
const LEFT_OUT = " …";

// one doc by its path, several in one directory by it, else the first
// and a count; never cut
export function savedText(saved: SavedDocs | null): string {
  if (saved === null || saved.count === 0) return "";
  if (saved.count === 1) return ` saved ${saved.paths[0]}`;
  if (saved.dir !== null) return ` saved ${saved.count} files in ${saved.dir}/`;
  return ` saved ${saved.paths[0]} and ${saved.count - 1} more`;
}

// name, summary and status, then the saved docs, then the mark. The
// name, status and mark always show; the summary is cut to leave room
// for the saved docs, which show whole or as a … when they cannot fit
export function traceLine(call: TraceCall, yours: Yours): string {
  const status = call.status === "done" ? "ok" : "failed";
  const mark = foreign(call, yours) ? NOT_YOURS : "";
  const name = cut(
    call.name,
    TRACE_LINE_CHARS - status.length - 1 - mark.length,
  );
  const fixed = name.length + 1 + status.length + mark.length;
  const docs = savedText(call.saved);
  const fits = fixed + docs.length <= TRACE_LINE_CHARS;
  const said = cut(
    summary(call),
    Math.max(TRACE_LINE_CHARS - fixed - (fits ? docs.length : 0) - 1, 0),
  );
  const line = said === "" ? `${name} ${status}` : `${name} ${said} ${status}`;
  const tail =
    docs === "" || fits
      ? docs
      : line.length + LEFT_OUT.length + mark.length <= TRACE_LINE_CHARS
        ? LEFT_OUT
        : "";
  return line + tail + mark;
}

// the heading and one line a call, identical lines as one with ×N where
// the first stood; past the cap one line counts the calls left. Empty
// for a turn without calls
export function trace(calls: readonly TraceCall[], yours: Yours): string {
  if (calls.length === 0) return "";
  const counts = new Map<string, number>();
  for (const call of calls) {
    const line = traceLine(call, yours);
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const lines = [...counts];
  const shown = lines
    .slice(0, TRACE_LINES)
    .map(([line, n]) => (n === 1 ? line : `${line} ×${n}`));
  const more = lines.slice(TRACE_LINES).reduce((sum, [, n]) => sum + n, 0);
  if (more > 0) {
    shown.push(`and ${more} more ${more === 1 ? "call" : "calls"}`);
  }
  return [TRACE_HEADING, ...shown].join("\n");
}
