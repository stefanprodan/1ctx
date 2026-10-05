// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { diff, extract, type File, type Model } from "../../scripts/models.ts";

// the catalog's shape, with the fields the script reads
const catalog = (azure: Record<string, Model>) => ({
  azure: { models: azure },
  google: { models: {} },
  "opencode-go": {
    models: {
      "glm-5.2": {
        tool_call: true,
        limit: { context: 1_000_000 },
        cost: { input: 0.4, output: 1.6 },
      },
    },
  },
  openrouter: { models: { other: { limit: { context: 1 } } } },
});

const SOL = {
  tool_call: true,
  canonical_model_id: "openai/gpt-6.1-sol",
  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
  cost: {
    input: 2,
    output: 10,
    cache_read: 0.1,
    cache_write: 2.5,
    tiers: [
      {
        input: 4,
        output: 15,
        cache_read: 0.2,
        cache_write: 5,
        tier: { type: "context", size: 272_000 },
      },
    ],
    context_over_200k: { input: 4, output: 15 },
  },
};

describe("scripts/models.ts", () => {
  test("keeps the input cap and the tiers over context_over_200k", () => {
    const out = extract(catalog({ "gpt-6.1-sol": SOL }));
    expect(out.azure!["gpt-6.1-sol"]).toEqual({
      window: 922_000,
      tools: true,
      price: {
        input: 2,
        output: 10,
        cacheRead: 0.1,
        cacheWrite: 2.5,
        tiers: [
          {
            above: 272_000,
            input: 4,
            output: 15,
            cacheRead: 0.2,
            cacheWrite: 5,
          },
        ],
      },
    });
  });

  test("reads context_over_200k only for a model with no tiers", () => {
    const { tiers: _, ...cost } = SOL.cost;
    const out = extract(catalog({ m: { ...SOL, cost } }));
    expect(
      (out.azure!.m as { price: { tiers: unknown[] } }).price.tiers,
    ).toEqual([{ above: 200_000, input: 4, output: 15 }]);
  });

  test("keeps a canonical name apart from the id, never a price on Go", () => {
    const out = extract(catalog({ "prod-sol": SOL }));
    expect(out.azure!["prod-sol"]).toMatchObject({ canonical: "gpt-6.1-sol" });
    expect(out["opencode-go"]).toEqual({
      "glm-5.2": { window: 1_000_000, tools: true },
    });
    expect(Object.keys(out)).toEqual(["azure", "google", "opencode-go"]);
  });

  test("leaves out a model with neither a window nor a price", () => {
    expect(extract(catalog({ bare: { tool_call: true } })).azure).toEqual({});
  });
});

describe("scripts/models.ts --diff", () => {
  const file = (azure: File["providers"][string]): File => ({
    providers: { azure, google: {}, "opencode-go": {} },
  });
  const sol = {
    window: 922_000,
    tools: true,
    price: {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      tiers: [{ above: 272_000, input: 4, output: 15 }],
    },
  };

  test("is empty for equal files", () => {
    expect(diff(file({ sol }), file({ sol }))).toBe("");
  });

  test("lists removals first, then additions, then each changed value", () => {
    const before = file({ old: { tools: false }, sol });
    const after = file({
      fresh: { window: 128_000, tools: true },
      sol: {
        ...sol,
        price: {
          ...sol.price,
          cacheRead: 0.05,
          tiers: [{ above: 272_000, input: 5, output: 15 }],
        },
      },
    });
    const rows = diff(before, after)
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| Model"));
    expect(rows).toEqual([
      "| old | removed | | |",
      "| fresh | added | | window 128,000, tools yes |",
      "| sol | cacheRead | $0.1 | $0.05 |",
      "| sol | input above 272,000 | $4 | $5 |",
    ]);
  });

  test("names a value that appears or goes as none", () => {
    const after = file({ sol: { ...sol, window: undefined } });
    expect(diff(file({ sol }), after)).toContain(
      "| sol | window | 922,000 | none |",
    );
  });
});
