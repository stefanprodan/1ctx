// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Another agent's turn as the building agent reads it: its calls, one
// line each, never their results, reasoning or signatures, so no
// provider sees a call without its result and no model reads a call as
// a finding. Written by code from the stored calls: the same calls give
// the same bytes, so the trace never moves a cached prefix.

import type { Message } from "../../shared/contracts/session.ts";

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
};

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
      const result = tools[index];
      const paired = result?.toolCallId === call.id ? result : undefined;
      out.push({
        ...(call.name === "mcp_call"
          ? unwrapped(call.arguments)
          : { name: call.name, arguments: call.arguments }),
        ...(paired?.toolName ? { name: paired.toolName } : {}),
        status: paired?.status ?? null,
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
// query, a fetch's URL, a path, an MCP tool's arguments; a visual and a
// skill by their tool name alone
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
    case "visualize":
    case "skill":
    case "skill_file":
      return "";
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

export function traceLine(call: TraceCall): string {
  const status = call.status === "done" ? "ok" : "failed";
  const room = TRACE_LINE_CHARS - call.name.length - status.length - 2;
  const said = cut(summary(call), Math.max(room, 0));
  return said === ""
    ? `${call.name} ${status}`
    : `${call.name} ${said} ${status}`;
}

// the heading and one line a call, identical lines as one with ×N where
// the first stood; past the cap one line counts the calls left. Empty
// for a turn without calls
export function trace(calls: readonly TraceCall[]): string {
  if (calls.length === 0) return "";
  const counts = new Map<string, number>();
  for (const call of calls) {
    const line = traceLine(call);
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
