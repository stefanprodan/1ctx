// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Dictation kind: one per instance, its provider known and on a
// transcription wire before anything is written, its model checked
// against the live catalog, and its switch kept when left out.

import { describe, expect, test } from "bun:test";
import {
  GEMINI_URL,
  MLX_URL,
  PROVIDER_URL,
  type TestApp,
  testApp,
} from "../../helpers/app.ts";
import { documents, object } from "./helpers.ts";

const ASR = "mlx-community/Qwen3-ASR-1.7B-8bit";
const VOXTRAL = "mistralai/voxtral-mini-transcribe-3-0";
const WHISPER = "openai/whisper-large-v3-turbo";

const mlx = object("Provider", "mlx-serve", {
  wire: "openai-compatible",
  baseUrl: MLX_URL,
  keyFrom: null,
});
const router = object("Provider", "router", {
  wire: "openrouter",
  baseUrl: PROVIDER_URL,
  keyFrom: "provider-router",
});
const gemini = object("Provider", "gem", {
  wire: "gemini",
  baseUrl: GEMINI_URL,
  keyFrom: "provider-router",
});
const dictation = (spec: Record<string, unknown>, name = "dictation") =>
  object("Dictation", name, spec);

type Row = { provider_id: string; model: string; enabled: number };
const held = (app: TestApp) =>
  app.db
    .query<Row, []>(
      "select provider_id, model, enabled from dictation_settings",
    )
    .get();
const idOf = (app: TestApp, name: string) =>
  app.providers.list().find((row) => row.name === name)!.id;

async function run(
  body: (app: TestApp, apply: typeof applied) => Promise<void>,
) {
  const app = await testApp({
    activate: false,
    secrets: { "provider-router": "router-key" },
  });
  try {
    await body(app, applied);
  } finally {
    await app.shutdown();
    app.db.close();
  }
  async function applied(...objects: ReturnType<typeof object>[]) {
    const lines: string[] = [];
    await app.provision.apply(documents(...objects), (line) =>
      lines.push(line),
    );
    return lines;
  }
}

describe("provision Dictation", () => {
  test("a second Dictation document is refused", () => {
    expect(() =>
      documents(
        dictation({ provider: "mlx-serve", model: ASR }),
        dictation({ enabled: false }, "other"),
      ),
    ).toThrow(
      "Dictation/other: one Dictation object per instance (first Dictation/dictation)",
    );
  });

  test("is created after its Provider in the same apply, off without enabled", async () => {
    await run(async (app, apply) => {
      // listed first, applied after the provider it names
      const lines = await apply(
        dictation({ provider: "mlx-serve", model: ASR }),
        mlx,
      );
      expect(lines.slice(1, -1)).toEqual([
        "created provider/mlx-serve",
        "created dictation/dictation",
      ]);
      expect(held(app)).toEqual({
        provider_id: idOf(app, "mlx-serve"),
        model: ASR,
        enabled: 0,
      });
    });
  });

  test("updates the model and the switch, keeping the switch when left out", async () => {
    await run(async (app, apply) => {
      await apply(
        mlx,
        router,
        dictation({ provider: "mlx-serve", model: ASR, enabled: true }),
      );
      expect(held(app)?.enabled).toBe(1);
      // any name updates the one held, and the switch stays
      expect(
        await apply(
          dictation({ provider: "router", model: VOXTRAL }, "speech"),
        ),
      ).toContain("updated dictation/speech");
      expect(held(app)).toEqual({
        provider_id: idOf(app, "router"),
        model: VOXTRAL,
        enabled: 1,
      });
      await apply(dictation({ model: WHISPER, enabled: false }));
      expect(held(app)).toMatchObject({ model: WHISPER, enabled: 0 });
      expect(await apply(dictation({ enabled: false }))).toContain(
        "unchanged dictation/dictation",
      );
      await apply(dictation({ enabled: true }));
      expect(held(app)).toMatchObject({ model: WHISPER, enabled: 1 });
    });
  });

  test("a new one needs a provider and a model", async () => {
    await run(async (app, apply) => {
      await expect(
        apply(mlx, dictation({ provider: "mlx-serve" })),
      ).rejects.toThrow(
        "Dictation/dictation: spec.model is required for a new object",
      );
      await expect(
        apply(dictation({ model: ASR, enabled: true })),
      ).rejects.toThrow(
        "Dictation/dictation: spec.provider is required for a new object",
      );
      expect(held(app)).toBeNull();
    });
  });

  test("an unknown provider is refused before anything is written", async () => {
    await run(async (app, apply) => {
      await expect(
        apply(mlx, dictation({ provider: "nope", model: ASR })),
      ).rejects.toThrow(
        "Dictation/dictation: spec.provider references missing Provider/nope",
      );
      expect(app.providers.list()).toEqual([]);
      expect(held(app)).toBeNull();
    });
  });

  test("a provider off the transcription wires is refused, in the input or held", async () => {
    await run(async (app, apply) => {
      const refusal =
        "Dictation/dictation: spec.provider Provider/gem is on the gemini wire, which serves no transcription (openrouter, openai-compatible)";
      await expect(
        apply(gemini, dictation({ provider: "gem", model: ASR })),
      ).rejects.toThrow(refusal);
      expect(app.providers.list()).toEqual([]);
      await apply(gemini);
      await expect(
        apply(dictation({ provider: "gem", model: ASR })),
      ).rejects.toThrow(refusal);
      expect(held(app)).toBeNull();
    });
  });

  test("a model the live catalog does not list is refused", async () => {
    await run(async (app, apply) => {
      await expect(
        apply(mlx, dictation({ provider: "mlx-serve", model: VOXTRAL })),
      ).rejects.toThrow(
        `Dictation/dictation: mlx-serve does not list ${VOXTRAL} as a transcription model`,
      );
      // the provider before it in the apply stays
      expect(app.providers.list().map((row) => row.name)).toEqual([
        "mlx-serve",
      ]);
      expect(held(app)).toBeNull();
    });
  });
});
