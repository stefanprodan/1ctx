// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { canStopThinking } from "../../src/shared/thinking.ts";

test("only a Gemini Pro on the Gemini wire cannot stop thinking", () => {
  expect(canStopThinking("gemini", "gemini-2.5-pro")).toBe(false);
  expect(canStopThinking("gemini", "gemini-3.1-Pro-preview")).toBe(false);
  expect(canStopThinking("gemini", "gemini-2.5-flash")).toBe(true);
  expect(canStopThinking("openrouter", "google/gemini-2.5-pro")).toBe(true);
  expect(canStopThinking(undefined, "gemini-2.5-pro")).toBe(true);
});
