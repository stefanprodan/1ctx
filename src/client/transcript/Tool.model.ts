// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message } from "../../shared/contracts/session.ts";
import type { ToolCall } from "../../shared/contracts/tool.ts";
import { secs } from "./stream.ts";

export const DISPLAY_RESULT_CHARS = 20_000;

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
    if (name === "get_current_time") {
      const zone = value.timezone ?? value.zone;
      return typeof zone === "string" ? zone : "";
    }
    const telling = Object.values(value).find(
      (item) => typeof item === "string",
    );
    return typeof telling === "string" ? telling : "";
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

export function displayResult(result: Message | null): string {
  const content = result?.content ?? "";
  if (content.length <= DISPLAY_RESULT_CHARS) return content;
  return `${content.slice(0, DISPLAY_RESULT_CHARS)}\n...`;
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
    state = secs(Math.max(0, result.finishedAt - result.createdAt));
  }
  return {
    argument: shortArg(call.name, call.arguments),
    state,
    live,
  };
}
