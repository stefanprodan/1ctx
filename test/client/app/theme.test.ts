// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The theme follows the system until the user flips the switch away
// from it; that flip is kept, and a flip back forgets it.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  resolveTheme,
  setTheme,
  THEME_KEY,
  theme,
  toggleTheme,
} from "../../../src/client/app/theme.ts";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

describe("resolveTheme", () => {
  test("follows the system while nothing is kept", () => {
    expect(resolveTheme(null, true)).toBe("light");
    expect(resolveTheme(null, false)).toBe("dark");
  });

  test("a kept choice wins over the system", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
  });

  test("anything else kept is ignored", () => {
    expect(resolveTheme("sepia", true)).toBe("light");
    expect(resolveTheme("", false)).toBe("dark");
  });
});

describe("the switch", () => {
  // the test runs without matchMedia, so the system reads as dark
  test.serial("a flip away from the system is kept, back forgets", () => {
    setTheme("dark");
    expect(store.has(THEME_KEY)).toBe(false);
    toggleTheme();
    expect(theme.value).toBe("light");
    expect(store.get(THEME_KEY)).toBe("light");
    toggleTheme();
    expect(theme.value).toBe("dark");
    expect(store.has(THEME_KEY)).toBe(false);
  });
});
