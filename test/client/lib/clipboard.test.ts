// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { copyText } from "../../../src/client/lib/clipboard.ts";

const real = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function withClipboard(clipboard: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard },
    configurable: true,
  });
}

afterEach(() => {
  if (real) Object.defineProperty(globalThis, "navigator", real);
});

describe("copyText", () => {
  test.serial("writes the text and says it landed", async () => {
    let written = "";
    withClipboard({
      writeText: async (t: string) => {
        written = t;
      },
    });
    expect(await copyText("a link")).toBe(true);
    expect(written).toBe("a link");
  });

  test.serial("says false when the clipboard refuses", async () => {
    withClipboard({
      writeText: async () => {
        throw new DOMException("no focus", "NotAllowedError");
      },
    });
    expect(await copyText("x")).toBe(false);
  });

  test.serial("says false with no clipboard at all", async () => {
    withClipboard(undefined);
    expect(await copyText("x")).toBe(false);
  });
});
