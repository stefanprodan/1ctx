// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { ShowMore } from "../../../src/client/stream/Stream.tsx";

const ghosts = (html: string) => html.split("stream-ghost ").length - 1;

describe("Show more", () => {
  test("is not there at the end of the list", () => {
    const html = render(
      <ShowMore
        more={{ next: false, loading: false, error: null }}
        onMore={() => {}}
      />,
    );
    expect(html).toBe("");
  });

  test("is the list's last row while a page is left", () => {
    const html = render(
      <ShowMore
        more={{ next: true, loading: false, error: null }}
        onMore={() => {}}
      />,
    );
    expect(html).toContain("rows-button");
    expect(html).toContain("Show more");
    expect(html).not.toContain("notice-failed");
  });

  test("gives its place to three placeholders while the page loads", () => {
    const html = render(
      <ShowMore
        more={{ next: true, loading: true, error: null }}
        onMore={() => {}}
      />,
    );
    expect(html).not.toContain("Show more");
    expect(ghosts(html)).toBe(3);
  });

  test("says a failure under the button, words then the code", () => {
    const html = render(
      <ShowMore
        more={{
          next: true,
          loading: false,
          error: { words: "server busy", status: 503 },
        }}
        onMore={() => {}}
      />,
    );
    expect(html).toContain("Show more");
    expect(html).toMatch(
      /Server busy\.(<!-- -->)? <span class="code-tag">HTTP (<!-- -->)?503<\/span>/,
    );
  });
});
