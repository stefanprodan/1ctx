// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { path } from "../../../src/client/app/router.ts";
import { limits, tools, toolsError } from "../../../src/client/data/tools.ts";
import {
  collect,
  defaultLine,
  displayOf,
  draftOf,
  LIMIT_WORDS,
  limitFieldOf,
  problem,
  withSaved,
} from "../../../src/client/views/admin/Tools.model.ts";
import { Tools } from "../../../src/client/views/admin/Tools.tsx";
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
    expect(LIMIT_WORDS.maxBashCalls.label).toBe("Bash calls per send");
    expect(displayOf(tokenLimit)).toEqual({ word: "tokens", factor: 1 });
    expect(displayOf(bashLimit)).toEqual({ word: "", factor: 1 });
    expect(defaultLine(tokenLimit)).toBe("default 500000 tokens");
    expect(defaultLine(bashLimit)).toBe("default 100");
    expect(problem(tokenLimit, "9999")).toBe(
      "Tool-work tokens is 10000 to 10000000 tokens",
    );
    expect(problem(bashLimit, "1001")).toBe("Bash calls per send is 1 to 1000");
    expect(limitFieldOf("toolWorkTokens needs a number")).toBe(
      "toolWorkTokens",
    );
    expect(limitFieldOf("maxBashCalls is out of range")).toBe("maxBashCalls");
    for (const row of rows) {
      expect(problem(row, String(row.min))).toBeNull();
      expect(problem(row, String(row.max))).toBeNull();
    }
  });

  test("saves each scope without changing the other's budget", () => {
    expect(collect(rows, draftOf(rows))).toEqual({
      values: expect.objectContaining({
        toolWorkTokens: 750_000,
        maxBashCalls: 200,
      }),
    });
    expect(withSaved(rows, "send", { toolWorkTokens: 10_000 })).toEqual(
      expect.objectContaining({ toolWorkTokens: 10_000, maxBashCalls: 200 }),
    );
    expect(withSaved(rows, "call", { maxBashCalls: 1 })).toEqual(
      expect.objectContaining({ toolWorkTokens: 750_000, maxBashCalls: 1 }),
    );
  });

  test.serial("the Limits tab puts each labelled row in its own form", () => {
    const previous = {
      path: path.value,
      limits: limits.value,
      tools: tools.value,
      error: toolsError.value,
    };
    try {
      path.value = "/admin/tools/limits";
      limits.value = rows;
      tools.value = {
        builtin: [],
        web: [],
        search: {
          provider: null,
          keys: { exa: false, firecrawl: false, tavily: false },
        },
      };
      toolsError.value = null;
      const html = render(<Tools />);
      const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
      expect(forms).toHaveLength(3);
      const send = forms[0]!;
      const call = forms[1]!;
      expect(send).toContain("Tool-work tokens");
      expect(send).toContain('name="toolWorkTokens"');
      expect(send).toContain('value="750000"');
      expect(send).toContain("default 500000 tokens");
      expect(send).not.toContain('name="maxBashCalls"');
      expect(call).toContain("Bash calls per send");
      expect(call).toContain('name="maxBashCalls"');
      expect(call).toContain('value="200"');
      expect(call).toContain("default 100");
      expect(call).not.toContain('name="toolWorkTokens"');
    } finally {
      path.value = previous.path;
      limits.value = previous.limits;
      tools.value = previous.tools;
      toolsError.value = previous.error;
    }
  });
});
