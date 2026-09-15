// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message } from "../../shared/contracts/session.ts";
import type { ToolCall } from "../../shared/contracts/tool.ts";
import { splitWireName } from "../../shared/mcp.ts";
import { secs } from "./stream.ts";

// not on the wire: the chat fetches it when the row is opened, so a
// reader who never opens a row never pays for its result
export type ToolResult =
  | { status: "loading" }
  | { status: "done"; content: string; bytes: number; cut: boolean }
  | { status: "failed"; error: string };

// Keep MCP folds readable by naming the server before the tool.
export const MAX_MCP_ARGUMENT = 60;
export function toolLabel(name: string): {
  server: string | null;
  tool: string;
} {
  const split = splitWireName(name);
  return split === null ? { server: null, tool: name } : split;
}

export function shortArg(name: string, args: string): string {
  try {
    const value = JSON.parse(args || "{}") as Record<string, unknown>;
    if (name === "webfetch" && typeof value.url === "string") {
      const url = new URL(value.url);
      return url.host + (url.pathname === "/" ? "" : url.pathname);
    }
    if (name === "websearch" && typeof value.query === "string") {
      return value.query.replace(/\s+/g, " ").trim();
    }
    if (name === "datetime") {
      // the tool's default, so a call without one still says its zone
      return typeof value.timezone === "string" && value.timezone !== ""
        ? value.timezone
        : "UTC";
    }
    if (name === "skill" && typeof value.name === "string") {
      return value.name;
    }
    if (name === "skill_file" && typeof value.path === "string") {
      return value.path;
    }
    const telling = Object.values(value).find(
      (item) => typeof item === "string",
    );
    if (typeof telling !== "string") return "";
    // an MCP argument can be a whole manifest; the line shows its start
    return splitWireName(name) === null
      ? telling
      : telling.replace(/\s+/g, " ").trim().slice(0, MAX_MCP_ARGUMENT);
  } catch {
    return "";
  }
}

export function prettyArguments(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args || "{}"), null, 2);
  } catch {
    return args;
  }
}

// while the tool runs there is nothing stored yet, and a result held
// or in flight is never asked for twice
export function wantsResult(
  open: boolean,
  result: Message | null,
  held: ToolResult | undefined,
): boolean {
  if (!open || result === null || held !== undefined) return false;
  return result.status !== "streaming";
}

// decimal units, as a reader thinks of a page's size
export function bytesWord(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

// the server cut the content at the display cap; the ellipsis says so
export function displayResult(
  result: Message | null,
  held: ToolResult | undefined,
): { label: string; text: string; err: boolean } {
  const label = "result, untrusted";
  if (result === null || result.status === "streaming") {
    return { label, text: "", err: false };
  }
  if (held === undefined || held.status === "loading") {
    return { label, text: "loading", err: false };
  }
  if (held.status === "failed") return { label, text: held.error, err: true };
  const size = held.bytes > 0 ? `${label} · ${bytesWord(held.bytes)}` : label;
  const text = held.cut ? `${held.content}\n...` : held.content;
  return { label: size, text, err: false };
}

export type ToolSummary = {
  argument: string;
  state: string;
  live: boolean;
};

export function toolSummary(
  call: ToolCall,
  result: Message | null,
): ToolSummary {
  // the duration once done, "running" while the row streams, else the
  // row's status word; a call with no row was never run
  const live = result?.status === "streaming";
  let state = result?.status ?? "not run";
  if (live) state = "running";
  if (result?.status === "done" && result.finishedAt !== null) {
    const ms = Math.max(0, result.finishedAt - result.createdAt);
    state = ms < 100 ? "instant" : secs(ms);
  }
  return {
    argument: shortArg(call.name, call.arguments),
    state,
    live,
  };
}
