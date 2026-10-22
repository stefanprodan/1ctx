// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A Provider document over a held provider keeps its wire: a different
// one is refused before anything is written.

import { expect, test } from "bun:test";
import { GEMINI_URL, MLX_URL, testApp } from "../../helpers/app.ts";
import { documents, object } from "./helpers.ts";

test("a held provider's wire change is refused before any write", async () => {
  const app = await testApp({
    activate: false,
    secrets: { "provider-gem": "gem-key" },
  });
  const apply = (...objects: ReturnType<typeof object>[]) =>
    app.provision.apply(documents(...objects), () => {});
  const gem = (spec: Record<string, unknown>) =>
    object("Provider", "gem", spec);
  try {
    await apply(
      gem({ wire: "gemini", baseUrl: GEMINI_URL, keyFrom: "provider-gem" }),
    );
    const mlx = object("Provider", "mlx-serve", {
      wire: "openai-compatible",
      baseUrl: MLX_URL,
      keyFrom: null,
    });
    await expect(
      apply(mlx, gem({ wire: "openai-compatible" })),
    ).rejects.toThrow(
      "Provider/gem: spec.wire is gemini and a provider's wire never changes",
    );
    // mlx-serve comes first in the apply and was never written
    expect(app.providers.list().map((row) => [row.name, row.wire])).toEqual([
      ["gem", "gemini"],
    ]);
    expect(await apply(gem({ wire: "gemini" }))).toEqual({
      created: 0,
      updated: 0,
      unchanged: 1,
    });
    expect(await apply(gem({ baseUrl: GEMINI_URL }))).toEqual({
      created: 0,
      updated: 0,
      unchanged: 1,
    });
  } finally {
    await app.shutdown();
    app.db.close();
  }
});
