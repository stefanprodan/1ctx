// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { path } from "../../../src/client/app/router.ts";
import { limits, tools, toolsError } from "../../../src/client/data/tools.ts";
import { ConfigBoard } from "../../../src/client/views/admin/ConfigBoard.tsx";
import {
  defaultLine,
  displayOf,
  LIMIT_WORDS,
  limitFieldOf,
  problem,
} from "../../../src/client/views/admin/Tools.model.ts";
import type { LimitRow } from "../../../src/shared/contracts/limit.ts";

const tokenLimit: LimitRow = {
  name: "toolWorkTokens",
  default: 500_000,
  value: 750_000,
  min: 10_000,
  max: 10_000_000,
  unit: "tokens",
  scope: "send",
  changedAt: 1,
};
const bashLimit: LimitRow = {
  name: "maxBashCalls",
  default: 100,
  value: 200,
  min: 1,
  max: 1000,
  unit: "count",
  scope: "call",
  changedAt: 1,
};
const rows = [tokenLimit, bashLimit];

describe("send budget fields", () => {
  test("names both limits in their own units", () => {
    expect(LIMIT_WORDS.toolWorkTokens.label).toBe("Tool-work tokens");
    expect(LIMIT_WORDS.maxBashCalls.label).toBe("Bash calls per turn");
    expect(displayOf(tokenLimit)).toEqual({ word: "tokens", factor: 1 });
    expect(displayOf(bashLimit)).toEqual({ word: "", factor: 1 });
    expect(defaultLine(tokenLimit)).toBe("default 500000 tokens");
    expect(defaultLine(bashLimit)).toBe("default 100");
    expect(problem(tokenLimit, "9999")).toBe(
      "Tool-work tokens must be from 10000 to 10000000 tokens",
    );
    expect(problem(bashLimit, "1001")).toBe(
      "Bash calls per turn must be from 1 to 1000",
    );
    expect(limitFieldOf("toolWorkTokens needs a number")).toBe(
      "toolWorkTokens",
    );
    expect(limitFieldOf("maxBashCalls is out of range")).toBe("maxBashCalls");
    for (const row of rows) {
      expect(problem(row, String(row.min))).toBeNull();
      expect(problem(row, String(row.max))).toBeNull();
    }
  });

  test.serial("the Turns card holds both limits", () => {
    const previous = {
      path: path.value,
      limits: limits.value,
      tools: tools.value,
      error: toolsError.value,
    };
    try {
      path.value = "/admin/config/limits";
      limits.value = rows;
      tools.value = {
        builtin: [],
        access: { mode: "all", domains: [], updatedAt: 0 },
        search: {
          provider: null,
          keys: { exa: false, firecrawl: false, tavily: false },
        },
        visualize: {
          name: "visualize",
          description: "Draw a visual.",
          parameters: {},
          parametersHtml: "",
          tokens: 1,
          enabled: true,
          hosts: [],
          updatedAt: 0,
        },
      };
      toolsError.value = null;
      const html = render(<ConfigBoard />);
      const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
      const turns = forms[0]!;
      expect(turns).toContain(">Turns<");
      expect(turns).toContain('name="toolWorkTokens"');
      expect(turns).toContain('value="750000"');
      expect(turns).toContain("default 500000 tokens");
      expect(turns).toContain("Bash calls per turn");
      expect(turns).toContain('name="maxBashCalls"');
      expect(turns).toContain('value="200"');
      expect(turns).toContain("default 100");
      expect(forms[1]).not.toContain('name="maxBashCalls"');
    } finally {
      path.value = previous.path;
      limits.value = previous.limits;
      tools.value = previous.tools;
      toolsError.value = previous.error;
    }
  });
});
