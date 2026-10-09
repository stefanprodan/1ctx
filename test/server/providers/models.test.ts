// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  type Fetcher,
  fetchCatalog,
  withModelsDev,
} from "../../../src/server/providers/index.ts";
import data from "../../../src/server/providers/models.json" with {
  type: "json",
};
import {
  costOf,
  factsByName,
  MODEL_SOURCES,
  type ModelPrice,
  modelFacts,
  modelPrice,
  modelSource,
} from "../../../src/server/providers/models.ts";
import type { CatalogMatch } from "../../../src/shared/contracts/provider.ts";
import { MIN_CONTEXT_LENGTH, WIRES } from "../../../src/shared/words.ts";

type Listed = {
  window?: number;
  tools: boolean;
  canonical?: string;
  price?: { input: number; output: number; tiers?: { above: number }[] };
};

const providers = data.providers as Record<string, Record<string, Listed>>;

const row = (over: Partial<CatalogMatch>): CatalogMatch => ({
  id: "m",
  name: "m",
  contextLength: null,
  promptPrice: null,
  completionPrice: null,
  tools: false,
  reasoning: false,
  thinkingRequired: false,
  reasoningKnown: false,
  described: false,
  ...over,
});

// a model of the file with a window, a price and a tier
const tiered = () => {
  for (const [id, m] of Object.entries(providers.azure)) {
    if (m.window && m.price?.tiers?.length) return { id, m };
  }
  throw new Error("no tiered azure model");
};

describe("models.json", () => {
  test("holds the three dedicated wires' providers, prices on two", () => {
    expect(Object.keys(providers).sort()).toEqual([...MODEL_SOURCES]);
    for (const source of MODEL_SOURCES) {
      const models = Object.values(providers[source]);
      expect(models.length).toBeGreaterThan(0);
      const priced = models.some((m) => m.price !== undefined);
      expect({ source, priced }).toEqual({
        source,
        priced: source !== "opencode-go",
      });
    }
  });

  test("lists sane windows and rates, tiers ascending", () => {
    for (const source of MODEL_SOURCES) {
      for (const [model, m] of Object.entries(providers[source])) {
        const ok =
          (m.window === undefined || m.window > 0) &&
          (m.price === undefined ||
            (m.price.input >= 0 && m.price.output >= 0));
        expect({ model, ok }).toEqual({ model, ok: true });
        const above = (m.price?.tiers ?? []).map((t) => t.above);
        expect(above).toEqual([...above].sort((a, b) => a - b));
      }
    }
  });
});

describe("modelSource", () => {
  test("maps the dedicated wires and none of the others", () => {
    expect(WIRES.map((wire) => [wire, modelSource(wire)])).toEqual([
      ["openrouter", null],
      ["openai-compatible", null],
      ["openai-strict", null],
      ["gemini", "google"],
      ["opencode", "opencode-go"],
      ["azure", "azure"],
      ["anthropic", "anthropic"],
    ]);
  });
});

describe("factsByName", () => {
  test("finds a model under a host's prefix, in any case", () => {
    const [id, m] = Object.entries(providers["opencode-go"]).find(
      ([, m]) => m.window !== undefined,
    )!;
    const want = { contextLength: m.window, tools: m.tools };
    expect(factsByName(`some-org/${id.toUpperCase()}`)).toMatchObject(want);
  });

  test("finds a model by its canonical name", () => {
    const listed = MODEL_SOURCES.flatMap((s) =>
      Object.values(providers[s]).filter((m) => m.canonical && m.window),
    );
    expect(listed.length).toBeGreaterThan(0);
    for (const m of listed) {
      const found = factsByName(`org/${m.canonical}`);
      expect(found?.contextLength).toBeLessThanOrEqual(m.window!);
    }
  });

  test("keeps the smaller window of two models of one name", () => {
    const windows = new Map<string, number[]>();
    for (const s of MODEL_SOURCES) {
      for (const [id, m] of Object.entries(providers[s])) {
        if (m.window === undefined || m.window < MIN_CONTEXT_LENGTH) continue;
        const name = id.toLowerCase();
        windows.set(name, [...(windows.get(name) ?? []), m.window]);
      }
    }
    for (const [name, list] of windows) {
      expect(factsByName(name)?.contextLength).toBe(Math.min(...list));
    }
  });

  test("never suggests a window an agent cannot take", () => {
    const small = MODEL_SOURCES.flatMap((s) =>
      Object.entries(providers[s]).filter(
        ([, m]) => m.window !== undefined && m.window < MIN_CONTEXT_LENGTH,
      ),
    );
    for (const [id] of small) {
      expect(factsByName(id)?.contextLength ?? null).toBeNull();
    }
  });

  test("is null for a name none of the three lists", () => {
    expect(factsByName("org/no-such-model")).toBeNull();
    expect(factsByName("constructor")).toBeNull();
  });
});

describe("modelFacts and modelPrice", () => {
  test("read a model's window, tools and rates, cache rates filled", () => {
    const { id, m } = tiered();
    expect(modelFacts("azure", id)).toEqual({
      contextLength: m.window!,
      tools: m.tools,
    });
    const price = modelPrice("azure", id)!;
    expect(price.input).toBe(m.price!.input);
    expect(typeof price.cacheRead).toBe("number");
    expect(typeof price.cacheWrite).toBe("number");
    expect(price.tiers.length).toBe(m.price!.tiers!.length);
  });

  test("bill a cache rate the catalog leaves out at the input rate", () => {
    const [id, m] = Object.entries(providers.azure).find(
      ([, m]) =>
        m.price !== undefined &&
        !("cacheWrite" in m.price) &&
        !("cacheRead" in m.price),
    )!;
    expect(modelPrice("azure", id)).toMatchObject({
      cacheRead: m.price!.input,
      cacheWrite: m.price!.input,
    });
  });

  test("are null for a model the file does not list", () => {
    expect(modelFacts("azure", "no-such-model")).toBeNull();
    expect(modelPrice("azure", "__proto__")).toBeNull();
    expect(modelPrice("opencode-go", "anything")).toBeNull();
  });
});

describe("withModelsDev", () => {
  test("suggests an undescribed row's window and tools, and prices it", () => {
    const { id, m } = tiered();
    expect(withModelsDev(row({ id, name: id }), "azure")).toMatchObject({
      contextLength: m.window,
      tools: m.tools,
      promptPrice: m.price!.input,
      completionPrice: m.price!.output,
      described: false,
      listedAs: id,
    });
  });

  test("finds an Azure deployment by its model, not its id", () => {
    const { id, m } = tiered();
    const out = withModelsDev(
      row({ id: "prod", name: `prod (${id})`, listedAs: id }),
      "azure",
    );
    expect(out).toMatchObject({ id: "prod", contextLength: m.window });
    expect(out.listedAs).toBe(id);
  });

  test("never overrides what a described row says, but prices it", () => {
    const [id, m] = Object.entries(providers.google).find(
      ([, m]) => m.price !== undefined,
    )!;
    const described = row({
      id,
      contextLength: 5,
      tools: false,
      described: true,
    });
    expect(withModelsDev(described, "gemini")).toEqual({
      ...described,
      promptPrice: m.price!.input,
      completionPrice: m.price!.output,
      listedAs: id,
    });
  });

  test("gives an OpenCode Go row its window and no price", () => {
    const [id, m] = Object.entries(providers["opencode-go"]).find(
      ([, m]) => m.window !== undefined,
    )!;
    expect(withModelsDev(row({ id }), "opencode")).toMatchObject({
      contextLength: m.window,
      promptPrice: null,
      completionPrice: null,
      listedAs: id,
    });
  });

  test("an OpenAI wire's row takes a window by name, never a price", () => {
    const [id] = Object.entries(providers.azure).find(
      ([, m]) => m.window !== undefined && m.price !== undefined,
    )!;
    const out = withModelsDev(row({ id: `org/${id}` }), "openai-strict");
    expect(out.contextLength).toBe(factsByName(id)!.contextLength);
    expect(out.promptPrice).toBeNull();
    expect(out.listedAs).toBeUndefined();
  });

  test("keeps the id of a row models.dev lacks, for a later refresh", () => {
    const plain = row({ id: "no-such-model" });
    expect(withModelsDev(plain, "azure")).toEqual({
      ...plain,
      listedAs: "no-such-model",
    });
    expect(withModelsDev(plain, "openai-compatible")).toEqual(plain);
  });
});

describe("costOf", () => {
  // GPT-6.1 Sol's rates, a 272K tier above them
  const SOL: ModelPrice = {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    tiers: [
      { above: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
    ],
  };
  const usage = (over: Partial<Parameters<typeof costOf>[0]>) => ({
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: null,
    cacheWriteTokens: null,
    cost: null,
    ...over,
  });

  test("matches OpenCode's sum for one Sol step", () => {
    // 3 uncached, 209,087 read and 230 written; 35 out
    const cost = costOf(
      usage({
        promptTokens: 3 + 209_087 + 230,
        completionTokens: 35,
        cachedTokens: 209_087,
        cacheWriteTokens: 230,
      }),
      "azure",
      SOL,
    );
    expect(cost).toBeCloseTo(0.0218397, 10);
  });

  test("takes the tier only past its size", () => {
    expect(costOf(usage({ promptTokens: 210_000 }), "azure", SOL)).toBeCloseTo(
      (210_000 * 2) / 1_000_000,
      10,
    );
    expect(costOf(usage({ promptTokens: 300_000 }), "azure", SOL)).toBeCloseTo(
      (300_000 * 4) / 1_000_000,
      10,
    );
  });

  test("keeps a reply's own cost and leaves an unpriced one null", () => {
    expect(costOf(usage({ cost: 0.5 }), "azure", SOL)).toBe(0.5);
    expect(costOf(usage({ promptTokens: 9 }), "azure", null)).toBeNull();
    expect(costOf(usage({ promptTokens: 9 }), null, null)).toBeNull();
  });

  test("is 0 on OpenCode Go, a flat plan", () => {
    expect(costOf(usage({ promptTokens: 9 }), "opencode", null)).toBe(0);
  });

  test("never counts cache tokens past the prompt", () => {
    const cost = costOf(
      usage({ promptTokens: 10, cachedTokens: 50, cacheWriteTokens: 50 }),
      "azure",
      SOL,
    );
    expect(cost).toBeCloseTo((10 * 0.1) / 1_000_000, 12);
  });
});

describe("fetchCatalog and models.dev", () => {
  // an id-only list whose one model shares a name with the file
  const [named] = Object.entries(providers["opencode-go"]).find(
    ([, m]) => m.window !== undefined,
  )!;
  const fetcher = (async () =>
    new Response(
      JSON.stringify({ data: [{ id: `org/${named}` }] }),
    )) as unknown as Fetcher;
  const provider = {
    wire: "openai-compatible" as const,
    baseUrl: "http://models.test/v1",
  };

  test("adds to a chat catalog and never to a decisions one", async () => {
    const [chat] = await fetchCatalog(fetcher, provider, null);
    expect(chat!.contextLength).toBe(factsByName(named)!.contextLength);
    const [decisions] = await fetchCatalog(
      fetcher,
      provider,
      null,
      "decisions",
    );
    expect(decisions!.contextLength).toBeNull();
  });
});
