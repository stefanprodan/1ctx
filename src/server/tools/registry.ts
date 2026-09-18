// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The ordered tool lookup. Unknown names, malformed arguments and
// throws become failed results so the runner only handles ToolResult.

import { sanitize } from "../../shared/memory.ts";
import type { ToolCall } from "../providers/index.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";

function clean(text: string, cut: number): string {
  return sanitize(text).slice(0, cut);
}

function describe(error: unknown, timeoutMs: number): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return `tool timed out after ${Math.round(timeoutMs / 1000)} seconds`;
  }
  return error instanceof Error ? error.message : String(error);
}

export class Registry {
  private readonly byName = new Map<string, Tool<string | ToolResult>>();

  // unknown() lets a caller whose set is not the send's usual one say
  // what is on offer instead of the bare not-found line
  constructor(
    tools: Tool<string | ToolResult>[],
    private readonly unknown = (name: string) => `tool "${name}" not found.`,
  ) {
    for (const tool of tools) this.byName.set(tool.name, tool);
  }

  get(name: string): Tool<string | ToolResult> | undefined {
    return this.byName.get(name);
  }

  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    let timeoutMs = ctx.caps.callTimeoutMs;
    let timeoutSignal: AbortSignal | null = null;
    let started = 0;
    try {
      const tool = this.byName.get(call.name);
      if (!tool) throw new Error(this.unknown(call.name));
      timeoutMs = tool.timeoutMs ?? ctx.caps.callTimeoutMs;
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.arguments === "" ? "{}" : call.arguments);
      } catch {
        throw new Error(`invalid JSON arguments for tool "${call.name}"`);
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error(`arguments for tool "${call.name}" must be an object`);
      }
      started = performance.now();
      timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([ctx.signal, timeoutSignal]);
      const result = await tool.run(parsed as Record<string, unknown>, {
        ...ctx,
        signal,
      });
      return {
        content: clean(
          typeof result === "string" ? result : result.content,
          ctx.caps.resultCut,
        ),
        error: typeof result === "string" ? false : result.error,
      };
    } catch (error) {
      // a tool with its own timer of the same length (an MCP call) can
      // throw its own words a moment before this one fires; past the
      // limit, the failure is this timeout either way
      const late =
        timeoutSignal !== null &&
        (timeoutSignal.aborted || performance.now() - started >= timeoutMs);
      const failure =
        late && !ctx.signal.aborted
          ? new DOMException("the tool call timed out", "TimeoutError")
          : error;
      const message = describe(failure, timeoutMs);
      return {
        content: clean(`Error: ${message}`, ctx.caps.resultCut),
        error: true,
      };
    }
  }
}
