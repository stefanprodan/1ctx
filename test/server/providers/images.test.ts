// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extract } from "../../../scripts/models.ts";
import { parseModels } from "../../../src/server/providers/anthropic.ts";
import {
  parseCatalog,
  withModelsDev,
} from "../../../src/server/providers/catalog.ts";
import { modelImages } from "../../../src/server/providers/models.ts";
import type { CatalogMatch } from "../../../src/shared/contracts/provider.ts";

const recorded = (...parts: string[]) =>
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "..", "fixtures", "providers", ...parts),
      "utf8",
    ),
  );

const imagesOf = (models: CatalogMatch[]) =>
  Object.fromEntries(models.map((m) => [m.id, m.images]));

describe("image input in the catalogs", () => {
  test("OpenRouter's input modalities say yes or no for every model", () => {
    const models = imagesOf(parseCatalog(recorded("models.json")));
    expect(models["deepseek/deepseek-v4.1-flash"]).toBe(true);
    expect(models["anthropic/claude-opus-5"]).toBe(true);
    expect(models["z-ai/glm-5.3"]).toBe(false);
    expect(Object.values(models).every((v) => v !== null)).toBe(true);
  });

  test("mlx-serve says so by vision or its input modalities, else nothing", () => {
    const models = imagesOf(
      parseCatalog({
        data: [
          {
            id: "ornith",
            capabilities: ["chat", "tool_use", "vision"],
            input_modalities: ["text", "image", "video"],
          },
          { id: "lfm", capabilities: ["chat"], input_modalities: ["text"] },
          { id: "older", capabilities: ["chat", "vision"] },
          { id: "quiet", capabilities: ["chat", "tool_use"] },
          { id: "bare" },
        ],
      }),
    );
    expect(models).toEqual({
      ornith: true,
      lfm: false,
      older: true,
      quiet: null,
      bare: null,
    });
  });

  test("Groq's and Anthropic's catalogs say it, NIM's does not", () => {
    const groq = imagesOf(parseCatalog(recorded("strict", "groq-models.json")));
    expect(groq).toEqual({
      "allam-2-7b": false,
      "whisper-large-v3": false,
      "qwen/qwen3.8-27b": true,
      "openai/gpt-oss-120b": false,
    });
    const nim = parseCatalog(recorded("strict", "nim-models.json"));
    expect(nim.every((m) => m.images === null)).toBe(true);
    const claude = parseModels(recorded("anthropic", "models.json"));
    expect(claude.length).toBeGreaterThan(0);
    expect(claude.every((m) => m.images === true)).toBe(true);
    const [silent] = parseModels({ data: [{ id: "claude-x" }] });
    expect(silent!.images).toBeNull();
  });

  test("models.dev fills a silent row on a dedicated wire, never by another host's name", () => {
    const row = (id: string): CatalogMatch => ({
      id,
      name: id,
      contextLength: 1000,
      promptPrice: null,
      completionPrice: null,
      tools: true,
      reasoning: false,
      thinkingRequired: false,
      reasoningKnown: true,
      described: true,
      images: null,
    });
    expect(modelImages("google", "gemini-3.8-flash")).toBe(true);
    expect(withModelsDev(row("gemini-3.8-flash"), "gemini").images).toBe(true);
    // the catalog's own word is kept
    expect(
      withModelsDev({ ...row("gemini-3.8-flash"), images: false }, "gemini")
        .images,
    ).toBe(false);
    expect(
      withModelsDev(row("gemini-3.8-flash"), "openai-compatible").images,
    ).toBeNull();
    expect(withModelsDev(row("not-listed"), "gemini").images).toBeNull();
  });

  test("the refresh script keeps models.dev's input modalities as a flag", () => {
    const listed = extract({
      anthropic: {
        models: {
          seer: {
            limit: { context: 1000 },
            modalities: { input: ["text", "image"] },
          },
          reader: { limit: { context: 1000 }, modalities: { input: ["text"] } },
          quiet: { limit: { context: 1000 } },
        },
      },
      azure: { models: {} },
      google: { models: {} },
      "opencode-go": { models: {} },
    });
    expect(listed.anthropic).toEqual({
      quiet: { window: 1000, tools: false },
      reader: { window: 1000, tools: false, images: false },
      seer: { window: 1000, tools: false, images: true },
    });
  });
});
