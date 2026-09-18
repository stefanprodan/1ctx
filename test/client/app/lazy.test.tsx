// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The lazy loader: nothing, then the view; the reason and a retry when
// the loader fails, and a later load() tries again.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { lazy } from "../../../src/client/app/lazy.ts";

describe("lazy", () => {
  test("renders the view once loaded", async () => {
    const View = lazy(async () => () => <p>loaded</p>);
    expect(render(<View />)).toBe("");
    await View.load();
    expect(render(<View />)).toBe("<p>loaded</p>");
  });

  test("a failed load shows the reason and a retry, then recovers", async () => {
    let attempts = 0;
    const View = lazy(async () => {
      attempts++;
      if (attempts === 1) throw new Error("chunk missing");
      return () => <p>loaded</p>;
    });
    await View.load();
    const html = render(<View />);
    expect(html).toContain("Chunk missing.");
    expect(html).toContain("Try again");
    await View.load();
    expect(render(<View />)).toBe("<p>loaded</p>");
    expect(attempts).toBe(2);
  });
});
