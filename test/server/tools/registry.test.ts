// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The registry's cleaning of what a tool answers, success and failure
// alike: controls, the C1 block and the bidi controls go, text stays.

import { describe, expect, test } from "bun:test";
import { TOOL_CAPS } from "../../../src/server/tools/limits.ts";
import { Registry } from "../../../src/server/tools/registry.ts";
import type { Tool, ToolContext } from "../../../src/server/tools/types.ts";

// built from code points, so no invisible character sits in the source
const char = (...codes: number[]) => String.fromCodePoint(...codes);
const NUL = char(0);
const ESC = char(0x1b);
const NEL = char(0x85);
const RLO = char(0x202e);
const LRE = char(0x202a);
const LRI = char(0x2066);
const PDI = char(0x2069);
const SHALOM = char(0x5e9, 0x5dc, 0x5d5, 0x5dd);

function context(): ToolContext {
  return {
    signal: new AbortController().signal,
    now: () => 0,
    budget: { fetches: 0, searches: 0, visualBytes: 0 },
    caps: TOOL_CAPS,
  };
}

function echo(text: string, fail = false): Registry {
  const tool: Tool = {
    name: "echo",
    description: "",
    parameters: {},
    run: async () => {
      if (fail) throw new Error(text);
      return text;
    },
  };
  return new Registry([tool]);
}

const call = { id: "c1", name: "echo", arguments: "{}" };

describe("the registry's result cleaning", () => {
  test("drops controls, C1 and bidi controls, keeps text and RTL letters", async () => {
    const dirty = `a${NUL}b${ESC}c${NEL}d${RLO}e${LRE}f${LRI}g${PDI}h\ti\nj ${SHALOM}`;
    expect(await echo(dirty).run(call, context())).toEqual({
      content: `abcdefgh\ti\nj ${SHALOM}`,
      error: false,
    });
  });

  test("cleans a failure's words the same way", async () => {
    expect(await echo(`evil${RLO}txt.exe`, true).run(call, context())).toEqual({
      content: "Error: eviltxt.exe",
      error: true,
    });
  });

  test("keeps a built-in error that mentions timeout", async () => {
    expect(
      await echo("the upstream timeout policy refused this", true).run(
        call,
        context(),
      ),
    ).toEqual({
      content: "Error: the upstream timeout policy refused this",
      error: true,
    });
  });

  test("names a timeout past the limit when the tool threw its own words first", async () => {
    const tool: Tool = {
      name: "echo",
      description: "",
      parameters: {},
      timeoutMs: 20,
      run: async () => {
        await Bun.sleep(30);
        throw new Error("MCP request timed out");
      },
    };
    expect(await new Registry([tool]).run(call, context())).toEqual({
      content: "Error: tool timed out after 0 seconds",
      error: true,
    });
  });
});
