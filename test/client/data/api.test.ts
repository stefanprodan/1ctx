// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One call to the server: the server's own words pass through as the
// error, and an answer without them, a crash page or no answer at all,
// gets plain words for its status, never the status code.

import { afterEach, describe, expect, test } from "bun:test";
import {
  type ApiError,
  api,
  statusWords,
} from "../../../src/client/data/api.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(response: () => Response): void {
  globalThis.fetch = (async () => response()) as unknown as typeof fetch;
}

async function refusal(): Promise<ApiError> {
  try {
    await api("/api/tools");
  } catch (err) {
    return err as ApiError;
  }
  throw new Error("the call went through");
}

describe("api", () => {
  test.serial("the server's own words are the error", async () => {
    answer(() => Response.json({ error: "email is taken" }, { status: 409 }));
    const err = await refusal();
    expect(err.status).toBe(409);
    expect(err.message).toBe("email is taken");
  });

  test.serial("a crash page never shows its status code", async () => {
    answer(() => new Response("<html>boom</html>", { status: 500 }));
    const err = await refusal();
    expect(err.status).toBe(500);
    expect(err.message).not.toContain("500");
    expect(err.message).toBe(statusWords(500));
  });

  test.serial("no answer at all is status 0 with its words", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const err = await refusal();
    expect(err.status).toBe(0);
    expect(err.message).toBe("the server did not answer");
  });

  test("every status has words without a number in them", () => {
    for (const status of [0, 400, 403, 404, 405, 413, 429, 500, 502, 503]) {
      expect(statusWords(status)).not.toMatch(/\d/);
    }
  });
});
