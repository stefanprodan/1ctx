// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The ordered tool lookup. Unknown names, malformed arguments and
// throws become failed results so the runner only handles ToolResult.

import { parseArguments } from "../../shared/contracts/tool.ts";
import { sanitize } from "../../shared/memory.ts";
import { ToolError } from "../lib/errors.ts";
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

// a call's arguments as an object, or the words the model reads
export function parsedArgs(
  call: ToolCall,
  notObject = `arguments for tool "${call.name}" must be an object`,
): Record<string, unknown> {
  const parsed = parseArguments(call.arguments);
  if (parsed.ok) return parsed.args;
  throw new Error(
    parsed.reason === "json"
      ? `invalid JSON arguments for tool "${call.name}"`
      : notObject,
  );
}

function failed(
  failure: unknown,
  timedOut: boolean,
  timeoutMs: number,
  cut: number,
): ToolResult {
  const result: ToolResult = {
    content: clean(`Error: ${describe(failure, timeoutMs)}`, cut),
    error: true,
  };
  Object.defineProperty(result, timedOut ? "timedOut" : "failure", {
    value: timedOut ? true : failure,
  });
  return result;
}

// a call that failed before any tool ran, shaped as the registry would
export function failedCall(error: unknown, ctx: ToolContext): ToolResult {
  return failed(error, false, ctx.caps.callTimeoutMs, ctx.caps.resultCut);
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
      if (!tool) throw new ToolError(this.unknown(call.name), "tool not found");
      timeoutMs =
        (tool.timeoutMs ?? ctx.caps.callTimeoutMs) + (tool.graceMs ?? 0);
      const args = parsedArgs(call);
      started = performance.now();
      timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([ctx.signal, timeoutSignal]);
      const result = await tool.run(args, {
        ...ctx,
        signal,
      });
      if (typeof result !== "string" && result.tail !== undefined) {
        const content = sanitize(result.content);
        const start = Math.max(0, result.content.length - result.tail);
        const tail = clean(result.content.slice(start), ctx.caps.resultCut);
        return {
          ...result,
          content:
            content.slice(
              0,
              Math.min(
                content.length - tail.length,
                ctx.caps.resultCut - tail.length,
              ),
            ) + tail,
          error: result.error,
          tail: tail.length,
        };
      }
      return {
        ...(typeof result === "string" ? {} : result),
        content: clean(
          typeof result === "string" ? result : result.content,
          ctx.caps.resultCut,
        ),
        error: typeof result === "string" ? false : result.error,
      };
    } catch (error) {
      // a tool whose own deadline equals the call timeout may fail first;
      // past the limit it is this timeout
      const late =
        timeoutSignal !== null &&
        (timeoutSignal.aborted || performance.now() - started >= timeoutMs);
      const timedOut = late && !ctx.signal.aborted;
      const failure = timedOut
        ? new DOMException("the tool call timed out", "TimeoutError")
        : error;
      return failed(failure, timedOut, timeoutMs, ctx.caps.resultCut);
    }
  }
}
