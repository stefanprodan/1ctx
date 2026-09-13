// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The list of built-ins and the lookup by name; MCP tools merge here
// later. A call for a name not in the list, or arguments that are not a
// JSON object, is a failed result, never a throw. A tool that throws is
// turned into a failed result too: the model still gets the error text.

import type { ToolCall } from "../providers/index.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";

// controls that are not text and the C1 block, dropped so a page cannot
// smuggle escape sequences into the result the model reads
function clean(text: string, cut: number): string {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const control =
      (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159);
    if (!control) result += text[index];
  }
  return result.slice(0, cut);
}

function describe(error: unknown, timeoutMs: number): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return `tool timed out after ${Math.round(timeoutMs / 1000)} seconds`;
  }
  return error instanceof Error ? error.message : String(error);
}

// the ordered set of tools a send runs with, looked up by name; the area
// builds one per offered snapshot
export class Registry {
  private readonly byName = new Map<string, Tool>();

  constructor(tools: Tool[]) {
    for (const tool of tools) this.byName.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    try {
      const tool = this.byName.get(call.name);
      if (!tool) throw new Error(`tool "${call.name}" not found.`);
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
      const signal = AbortSignal.any([
        ctx.signal,
        AbortSignal.timeout(ctx.caps.callTimeoutMs),
      ]);
      const text = await tool.run(parsed as Record<string, unknown>, {
        ...ctx,
        signal,
      });
      return { content: clean(String(text), ctx.caps.resultCut), error: false };
    } catch (error) {
      const message = describe(error, ctx.caps.callTimeoutMs);
      return {
        content: clean(`Error: ${message}`, ctx.caps.resultCut),
        error: true,
      };
    }
  }
}
