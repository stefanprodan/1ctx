// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The lazy loader: a page's shape in bones, or the route's own, then
// the view; the reason and a retry when the loader fails, and a later
// load() tries again.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { lazy } from "../../../src/client/app/lazy.ts";

describe("lazy", () => {
  test("draws a page in bones until the view loads", async () => {
    const View = lazy(async () => () => <p>loaded</p>);
    const waiting = render(<View />);
    expect(waiting).toContain('class="page"');
    expect(waiting).toContain("page-waiting-crumb");
    expect(waiting.match(/role="status"/g)?.length).toBe(1);
    expect(waiting).toContain('aria-label="Loading the page"');
    expect(waiting).not.toContain(">Loading<");
    await View.load();
    expect(render(<View />)).toBe("<p>loaded</p>");
  });

  test("a route's own shape waits in its place, given the props", async () => {
    const View = lazy(
      async () => () => <p>loaded</p>,
      ({ id }: { id: string }) => <p role="status">waiting {id}</p>,
    );
    expect(render(<View id="c1" />)).toBe('<p role="status">waiting c1</p>');
    await View.load();
    expect(render(<View id="c1" />)).toBe("<p>loaded</p>");
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
    expect(html).not.toContain("bones-bone");
    await View.load();
    expect(render(<View />)).toBe("<p>loaded</p>");
    expect(attempts).toBe(2);
  });
});
