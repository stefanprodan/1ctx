// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A model's upstreams behind OpenRouter, parsed from a recorded answer.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CatalogError,
  fetchEndpoints,
  parseEndpoints,
} from "../../../src/server/providers/index.ts";

const recorded = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "fixtures",
      "providers",
      "openrouter",
      "endpoints.json",
    ),
    "utf8",
  ),
);

describe("parseEndpoints", () => {
  test("lists each tag once, cheapest first, with the discount already in the price", () => {
    const endpoints = parseEndpoints(recorded);
    expect(endpoints.map((e) => e.tag)).toEqual([
      "inference-net/fp4",
      "deepinfra/fp4",
      "relace",
      "baseten/fp8",
      "cloudflare",
    ]);
    expect(endpoints[0]).toEqual({
      tag: "inference-net/fp4",
      name: "InferenceNet",
      quantization: "fp4",
      promptPrice: 0.045,
      completionPrice: 0.14,
      discount: 0.5,
      tools: true,
      reasoning: true,
    });
    // "unknown" is no quantization
    expect(endpoints[2]).toMatchObject({ name: "Relace", quantization: null });
  });

  test("drops what has no tag and reads missing fields as unknown", () => {
    expect(parseEndpoints({})).toEqual([]);
    expect(
      parseEndpoints({
        data: {
          endpoints: [
            { tag: "" },
            { tag: "bare", pricing: { discount: 2 } },
            { tag: "priced", pricing: { prompt: "0.000001", completion: "0" } },
          ],
        },
      }),
    ).toEqual([
      {
        tag: "priced",
        name: "priced",
        quantization: null,
        promptPrice: 1,
        completionPrice: 0,
        discount: 0,
        tools: false,
        reasoning: false,
      },
      {
        tag: "bare",
        name: "bare",
        quantization: null,
        promptPrice: null,
        completionPrice: null,
        discount: 0,
        tools: false,
        reasoning: false,
      },
    ]);
  });
});

describe("fetchEndpoints", () => {
  test("asks for the model's path with the key and refuses a failed answer", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        auth: new Headers(init?.headers).get("authorization"),
      });
      return url.includes("gone")
        ? new Response("{}", { status: 404 })
        : Response.json(recorded);
    }) as unknown as typeof fetch;
    const provider = { baseUrl: "http://router.test/v1/" };
    expect(
      await fetchEndpoints(fetcher, provider, "k", "~z-ai/glm-5.3-flash:free"),
    ).toHaveLength(5);
    expect(seen[0]).toEqual({
      url: "http://router.test/v1/models/~z-ai/glm-5.3-flash%3Afree/endpoints",
      auth: "Bearer k",
    });
    await expect(
      fetchEndpoints(fetcher, provider, null, "gone/model"),
    ).rejects.toThrow(CatalogError);
  });
});
