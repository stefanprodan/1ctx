// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The recorded transcription answers and catalogs as pure parses: the
// text tidied with OpenRouter's cost, and the transcription rows a
// catalog keeps on each wire.

import { describe, expect, test } from "bun:test";
import { parseTranscriptionCatalog } from "../../../src/server/providers/catalog.ts";
import {
  parseTranscript,
  tidyTranscript,
} from "../../../src/server/providers/index.ts";

const fixture = async (name: string) =>
  JSON.parse(
    await Bun.file(
      `${import.meta.dir}/../../fixtures/providers/transcription/${name}`,
    ).text(),
  );

const ids = async (name: string, wire: "openrouter" | "openai-compatible") =>
  parseTranscriptionCatalog(await fixture(name), wire).map((m) => m.id);

describe("the transcription answers", () => {
  test("keep the text tidied and OpenRouter's cost", async () => {
    expect(
      parseTranscript(await fixture("openrouter-transcript.json")),
    ).toEqual({
      text: "Find me a pharmacy that is open now near the old town. And tell me how to get there by tram.",
      cost: 0.00001593738,
    });
    expect(parseTranscript(await fixture("mlx-transcript.json"))).toEqual({
      text: "Find me a pharmacy that is open now near the old town, and tell me how to get there by tram.",
      cost: null,
    });
    expect(parseTranscript(await fixture("mlx-refusal.json"))).toBeNull();
    expect(tidyTranscript("\n one\t two  \n three ")).toBe("one two three");
  });
});

describe("the transcription catalog", () => {
  test("keeps OpenRouter's rows, which list no capabilities", async () => {
    expect(await ids("openrouter-models.json", "openrouter")).toEqual([
      "mistralai/voxtral-mini-transcribe-3-0",
      "openai/whisper-large-v3-turbo",
    ]);
  });

  test("keeps only rows listing transcription on openai-compatible", async () => {
    expect(await ids("mlx-models.json", "openai-compatible")).toEqual([
      "mlx-community/Qwen3-ASR-1.7B-8bit",
    ]);
    // a server that ignores the query and lists no capabilities offers
    // its chat models, which are no transcription models
    expect(await ids("openrouter-models.json", "openai-compatible")).toEqual(
      [],
    );
  });
});
