// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The card of rows: what a row draws closed and open, where its body
// starts, and a toggle that shares its line.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  RowsCard,
  RowsLine,
  RowsOpen,
  RowsTitle,
} from "../../../src/client/ui/Rows.tsx";

const noop = () => {};

describe("RowsOpen", () => {
  test("a closed row draws the toggle as its line and no body", () => {
    const html = render(
      <RowsOpen open={false} onToggle={noop} head="ops">
        body
      </RowsOpen>,
    );
    expect(html).toContain('class="rows-toggle rows-line"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("body");
  });

  test("an open row draws its body under the head's text", () => {
    const open = (indent?: "avatar" | "chevron") =>
      render(
        <RowsOpen open onToggle={noop} head="ops" indent={indent}>
          body
        </RowsOpen>,
      );
    expect(open()).toContain('class="rows-body rows-body-avatar">body<');
    expect(open("chevron")).toContain('class="rows-body rows-body-chevron"');
    expect(open()).toContain("rows-item-open");
  });

  test("an end keeps the toggle inside a line of its own", () => {
    const html = render(
      <RowsOpen open={false} onToggle={noop} head="ops" end={<i>on</i>} />,
    );
    expect(html).toContain('<div class="rows-line rows-line-end"><button');
    expect(html).toContain('class="rows-toggle"');
    expect(html).toContain("<i>on</i>");
  });

  test("an off row says so on the item", () => {
    const html = render(<RowsOpen open={false} onToggle={noop} head="x" off />);
    expect(html).toContain('class="rows-item rows-item-off"');
  });
});

describe("the parts", () => {
  test("the card head carries a hint, a static row a label", () => {
    expect(render(<RowsCard label="Limits" hint="next send" />)).toContain(
      '<span class="rows-hint">next send</span>',
    );
    expect(render(<RowsLine as="label">exa</RowsLine>)).toContain(
      '<label class="rows-line rows-line-static">exa</label>',
    );
    expect(render(<RowsLine flush>exa</RowsLine>)).toContain(
      '<div class="rows-line">exa</div>',
    );
  });

  test("a title is mono only when asked and has a sub only when given", () => {
    expect(render(<RowsTitle name="ops" mono />)).toBe(
      '<span class="rows-title"><span class="rows-name rows-name-mono">ops</span></span>',
    );
    expect(render(<RowsTitle name="Oana" sub="@caelea" />)).toContain(
      '<span class="rows-sub">@caelea</span>',
    );
  });
});
