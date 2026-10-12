// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { AsideLine, AsideNames } from "../../../src/client/ui/Split.tsx";

const plain = (html: string) => html.replaceAll("<!-- -->", "");

describe("AsideLine", () => {
  test("its label is its own column", () => {
    expect(render(<AsideLine label="Role">Admin</AsideLine>)).toBe(
      '<div class="split-line split-pair"><span class="split-label">Role</span><span class="split-strong">Admin</span></div>',
    );
  });

  test("a cut value carries its whole text as the title", () => {
    const html = render(
      <AsideLine label="Zone" cut>
        America/Argentina/Buenos_Aires
      </AsideLine>,
    );
    expect(html).toContain(
      '<span class="split-strong cut" title="America/Argentina/Buenos_Aires">',
    );
  });

  test("a cut value of several strings joins them for the title", () => {
    const n = 3;
    expect(
      render(
        <AsideLine label="Size" cut>
          {n} files
        </AsideLine>,
      ),
    ).toContain('title="3 files"');
  });

  test("a cut value inside its own markup still gets the title", () => {
    expect(
      render(
        <AsideLine label="Key file" cut>
          <span class="error">http-x.key</span>
        </AsideLine>,
      ),
    ).toContain('<span class="split-strong cut" title="http-x.key">');
  });

  test("a value that wraps has no title", () => {
    const html = render(
      <AsideLine label="Scope">Part B of the proposal's delivery</AsideLine>,
    );
    expect(html).not.toContain("title=");
    expect(html).not.toContain(" cut");
  });
});

describe("AsideNames", () => {
  test("keeps each name whole, with its title, between commas", () => {
    expect(plain(render(<AsideNames names={["github", "linear"]} />))).toBe(
      '<span class="split-word" title="github">github</span>, <span class="split-word" title="linear">linear</span>',
    );
  });
});
