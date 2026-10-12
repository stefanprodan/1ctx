// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  AsideHandle,
  AsideItem,
  AsideLine,
  AsideNames,
  AsideNote,
} from "../../../src/client/ui/Split.tsx";

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

describe("a handle in an aside", () => {
  test("a linked line is the quiet handle, never the rows' yellow one", () => {
    const html = render(
      <AsideLine label="Owner" href="/users/ana">
        @ana
      </AsideLine>,
    );
    expect(html).toContain(
      '<a class="split-strong split-handle" href="/users/ana">@ana</a>',
    );
    expect(html).not.toContain("rows-handle");
  });

  test("AsideHandle links the name with its at sign", () => {
    expect(plain(render(<AsideHandle name="ana" href="/users/ana" />))).toBe(
      '<a class="split-handle" href="/users/ana">@ana</a>',
    );
  });
});

describe("AsideItem", () => {
  test("a plain name, never mono, with its count at the right", () => {
    const html = render(<AsideItem name="github">12</AsideItem>);
    expect(html).toBe(
      '<div class="split-line split-item"><span class="split-item-body"><span class="split-item-name cut" title="github">github</span></span><span class="split-item-end">12</span></div>',
    );
    expect(html).not.toContain("mono");
  });

  test("links its name to its page and keeps the whole name as title", () => {
    const html = render(
      <AsideItem name="plan.md" title="docs/plan.md" href="/k/1" />,
    );
    expect(html).toContain(
      '<a class="split-item-name split-handle cut" href="/k/1" title="docs/plan.md">plan.md</a>',
    );
    expect(html).not.toContain("split-item-end");
  });

  test("a faint line under it, linked when it has a page, a quiet word", () => {
    const html = render(
      <AsideItem name="mcp-a.key" sub="flux" subHref="/mcp/flux" quiet>
        in 2h
      </AsideItem>,
    );
    expect(html).toContain(
      '<span class="split-item-sub cut"><a class="split-handle" href="/mcp/flux">flux</a></span>',
    );
    expect(html).toContain(
      '<span class="split-item-end split-quiet">in 2h</span>',
    );
  });
});

describe("AsideNote", () => {
  test("a sentence across both columns, in its tone", () => {
    expect(render(<AsideNote>Paused</AsideNote>)).toBe(
      '<p class="split-note">Paused</p>',
    );
    expect(render(<AsideNote tone="error">No fire</AsideNote>)).toBe(
      '<p class="split-note split-note-error">No fire</p>',
    );
  });
});

describe("AsideNames", () => {
  test("keeps each name whole, with its title, between commas", () => {
    expect(plain(render(<AsideNames names={["github", "linear"]} />))).toBe(
      '<span class="split-word" title="github">github</span>, <span class="split-word" title="linear">linear</span>',
    );
  });
});
