// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The catalog parsed from the recorded body, searched id-prefix first,
// cached an hour per provider with one fetch in flight at a time.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderRow } from "../../../src/server/providers/index.ts";
import {
  CatalogError,
  Catalogs,
  fetchCatalog,
  parseCatalog,
  search,
} from "../../../src/server/providers/index.ts";
import { fakeFetch, PROVIDER_URL } from "../../helpers/app.ts";

const body = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "..", "fixtures", "providers", "models.json"),
    "utf8",
  ),
);
const models = parseCatalog(body);

const provider: ProviderRow = {
  id: "pr1",
  name: "router",
  wire: "openrouter",
  baseUrl: PROVIDER_URL,
  keyName: "router",
  createdAt: 0,
};

describe("parseCatalog", () => {
  test("carries the window, the prices per million tokens and the flags", () => {
    expect(models.length).toBe(52);
    expect(models[0]).toEqual({
      id: "deepseek/deepseek-v4.1-flash",
      name: "DeepSeek: DeepSeek V4.1 Flash",
      contextLength: 1048576,
      promptPrice: 0.15,
      completionPrice: 0.6,
      tools: true,
      reasoning: true,
    });
    const free = models.find(
      (m) => m.id === "nvidia/nemotron-3-super-120b-a12b:free",
    )!;
    expect([free.promptPrice, free.completionPrice]).toEqual([0, 0]);
  });

  test("takes the plain list an OpenAI-compatible server answers", () => {
    expect(
      parseCatalog({ data: [{ id: "local/qwen", object: "model" }] }),
    ).toEqual([
      {
        id: "local/qwen",
        name: "local/qwen",
        contextLength: null,
        promptPrice: null,
        completionPrice: null,
        tools: false,
        reasoning: false,
      },
    ]);
  });

  test("reads the capabilities an mlx-serve model lists", () => {
    const [m] = parseCatalog({
      data: [
        {
          id: "local/ornith",
          object: "model",
          context_length: 262144,
          capabilities: ["chat", "tool_use", "reasoning"],
        },
      ],
    });
    expect(m).toMatchObject({
      contextLength: 262144,
      tools: true,
      reasoning: true,
      promptPrice: null,
    });
  });

  test("skips what is not a model and a repeated id", () => {
    expect(
      parseCatalog({
        data: [{ id: "" }, 1, null, { name: "x" }, { id: "a" }, { id: "a" }],
      }).map((m) => m.id),
    ).toEqual(["a"]);
    expect(parseCatalog(null)).toEqual([]);
    expect(parseCatalog({ data: "no" })).toEqual([]);
  });
});

describe("search", () => {
  test("puts an id that starts with the text before the rest", () => {
    const ids = search(models, "deepseek/deepseek-v4-flash").map((m) => m.id);
    expect(ids.slice(0, 4)).toEqual([
      "deepseek/deepseek-v4-flash-vision-exp",
      "deepseek/deepseek-v4-flash-vision-exp:batch",
      "deepseek/deepseek-v4-flash-0731",
      "deepseek/deepseek-v4-flash-0731:batch",
    ]);
    expect(ids).toContain("~deepseek/deepseek-v4-flash-latest");
    expect(ids.indexOf("~deepseek/deepseek-v4-flash-latest")).toBeGreaterThan(
      4,
    );
  });

  test("matches the name too, ignores case, caps the answer", () => {
    expect(search(models, "OPUS 5").map((m) => m.id)).toEqual([
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-5:batch",
    ]);
    expect(search(models, "a").length).toBe(20);
    expect(search(models, "a", 3).length).toBe(3);
    expect(search(models, "  ")).toEqual([]);
    expect(search(models, "nothing-like-it")).toEqual([]);
  });
});

describe("fetchCatalog", () => {
  test("sends the key as a bearer and nothing without one", async () => {
    const fake = fakeFetch();
    await fetchCatalog(fake.fetcher, provider, "sk-test");
    await fetchCatalog(fake.fetcher, provider, null);
    expect(fake.calls.map((c) => c.headers.authorization ?? "none")).toEqual([
      "Bearer sk-test",
      "none",
    ]);
    expect(fake.calls[0].url).toBe(`${PROVIDER_URL}/models`);
  });

  test("names what went wrong", async () => {
    const answer = (res: () => Response | Promise<Response>) =>
      fetchCatalog(
        (async () => res()) as unknown as typeof fetch,
        provider,
        null,
      );
    await expect(
      answer(() => {
        throw new TypeError("unable to connect");
      }),
    ).rejects.toThrow(CatalogError);
    await expect(
      answer(() => new Response("no", { status: 401 })),
    ).rejects.toThrow("answered 401");
    await expect(answer(() => new Response("<html>"))).rejects.toThrow("JSON");
    await expect(answer(() => Response.json({ data: [] }))).rejects.toThrow(
      "empty",
    );
  });
});

describe("Catalogs", () => {
  test("fetches once an hour per provider and shares a fetch in flight", async () => {
    const fake = fakeFetch();
    const now = { value: 0 };
    const catalogs = new Catalogs({
      fetcher: fake.fetcher,
      clock: () => now.value,
      secret: (name) => (name === "router" ? "sk-router" : null),
    });
    const [a, b] = await Promise.all([
      catalogs.search(provider, "opus 5"),
      catalogs.model(provider, "deepseek/deepseek-chat"),
    ]);
    expect(a.length).toBe(2);
    expect(b?.id).toBe("deepseek/deepseek-chat");
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0].headers.authorization).toBe("Bearer sk-router");
    now.value = 59 * 60 * 1000;
    await catalogs.search(provider, "x");
    expect(fake.calls.length).toBe(1);
    now.value = 61 * 60 * 1000;
    await catalogs.search(provider, "x");
    expect(fake.calls.length).toBe(2);
    catalogs.forget(provider.id);
    await catalogs.model(provider, "none");
    expect(fake.calls.length).toBe(3);
  });

  test("a forget() while the fetch runs caches nothing", async () => {
    const fake = fakeFetch();
    const gates: (() => void)[] = [];
    const held = ((input: string, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        gates.push(() => {
          void fake.fetcher(input, init).then(resolve);
        });
      })) as unknown as typeof fetch;
    const catalogs = new Catalogs({
      fetcher: held,
      clock: () => 0,
      secret: () => null,
    });
    const first = catalogs.search(provider, "opus 5");
    catalogs.forget(provider.id);
    gates[0]();
    expect((await first).length).toBe(2);
    const again = catalogs.search(provider, "opus 5");
    expect(gates.length).toBe(2);
    gates[1]();
    expect((await again).length).toBe(2);
  });

  test("a catalog past the byte cap is refused", async () => {
    const big = `{"data":[${'{"id":"m"},'.repeat(900_000)}{"id":"z"}]}`;
    const fetcher = (async () => new Response(big)) as unknown as typeof fetch;
    await expect(fetchCatalog(fetcher, provider, null)).rejects.toThrow(
      "too large",
    );
  });

  test("a failure is not cached", async () => {
    let fail = true;
    const fake = fakeFetch();
    const fetcher = ((input: string, init?: RequestInit) => {
      if (fail) throw new TypeError("down");
      return fake.fetcher(input, init);
    }) as unknown as typeof fetch;
    const catalogs = new Catalogs({
      fetcher,
      clock: () => 0,
      secret: () => null,
    });
    await expect(catalogs.search(provider, "x")).rejects.toThrow(CatalogError);
    fail = false;
    expect((await catalogs.search(provider, "opus 5")).length).toBe(2);
  });
});
