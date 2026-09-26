// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The card of rows: what a row draws closed and open, where its body
// starts, and a toggle that shares its line.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  RowsBad,
  RowsButton,
  RowsCard,
  RowsCheck,
  RowsEnd,
  RowsFilters,
  RowsGo,
  RowsHandle,
  RowsLine,
  RowsList,
  RowsListHead,
  RowsLog,
  RowsLogGroup,
  RowsLogLine,
  RowsLogMore,
  RowsOpen,
  RowsSwitch,
  RowsTag,
  RowsTitle,
} from "../../../src/client/ui/Rows.tsx";

const noop = () => {};

test("compact logs escape names and notes, and carry failures and expansion", () => {
  const html = render(
    <RowsLog>
      <RowsLogGroup>{"<docs.zip>"}</RowsLogGroup>
      <RowsLogLine name="<script>" note="<refused>" bad status={409} />
      <RowsLogLine name="next.md" note="sending" running />
      <RowsLogMore onClick={noop}>Show all 14</RowsLogMore>
    </RowsLog>,
  );
  expect(html).toContain('class="rows-log"');
  expect(html).toContain("rows-log-bad");
  expect(html).toContain('class="code-tag">HTTP 409');
  expect(html).toContain("rows-log-running");
  expect(html).toContain("&lt;script>");
  expect(html).toContain("&lt;refused>");
  expect(html).toContain("&lt;docs.zip>");
  expect(html).toContain('type="button" class="btn-text rows-log-more"');
  expect(html).not.toContain("rows-sub");
  expect(render(<RowsLogLine name="x" note="unchanged" />)).not.toContain(
    "code-tag",
  );
});

test("a bare log with ends draws a remove button only on the lines that have one", () => {
  const html = render(
    <RowsLog bare ends>
      <RowsLogLine name="notes.md" note="12 KB" onRemove={noop} />
      <RowsLogLine name="shot.png" note="not text" />
    </RowsLog>,
  );
  expect(html).toContain('class="rows-log rows-log-bare rows-log-ends"');
  expect(html).toContain('class="rows-log-line rows-log-line-end"');
  expect(html).toContain(
    'class="btn-icon rows-log-drop" aria-label="Remove notes.md"',
  );
  expect(html.match(/rows-log-drop/g)).toHaveLength(1);
  // the uploader's log keeps its frame and draws no button
  expect(render(<RowsLog>x</RowsLog>)).toBe('<div class="rows-log">x</div>');
});

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
      '<span class="rows-hint cut">next send</span>',
    );
    expect(render(<RowsLine as="label">exa</RowsLine>)).toContain(
      '<label class="rows-line rows-line-static rows-line-pick">exa</label>',
    );
    expect(render(<RowsLine flush>exa</RowsLine>)).toContain(
      '<div class="rows-line">exa</div>',
    );
  });

  test("a title is mono only when asked and has a sub only when given", () => {
    expect(render(<RowsTitle name="ops" mono />)).toBe(
      '<span class="rows-title"><span class="rows-name rows-name-mono"><span class="cut">ops</span></span></span>',
    );
    expect(render(<RowsTitle name="Casey" sub="@casey" />)).toContain(
      '<span class="rows-sub">@casey</span>',
    );
  });
});

describe("the system's other parts", () => {
  test("an inset list holds the same rows, under its head", () => {
    const html = render(
      <>
        <RowsListHead label="Skills" hint="1 of 20" />
        <RowsList>
          <RowsButton onClick={noop}>
            <RowsTitle name="m" sub="id" />
          </RowsButton>
        </RowsList>
      </>,
    );
    expect(html).toContain('<span class="rows-list-hint">1 of 20</span>');
    expect(html).toContain(
      '<div class="rows-list"><div class="rows-item"><button type="button" class="rows-line rows-button">',
    );
  });

  test("a failed line, a tag, a handle and a failed part", () => {
    expect(render(<RowsTitle name="x" sub="broke" bad />)).toContain(
      '<span class="rows-sub rows-bad">broke</span>',
    );
    expect(render(<RowsTag>you</RowsTag>)).toBe('<span class="tag">you</span>');
    expect(render(<RowsHandle name="memo" />)).toBe(
      '<span class="rows-handle">@memo</span>',
    );
    expect(render(<RowsBad>failed</RowsBad>)).toBe(
      '<span class="rows-bad">failed</span>',
    );
  });

  test("a link row with an end keeps the button outside the link", () => {
    const html = render(
      <RowsGo href="/x" end={<button type="button">Stop</button>}>
        <RowsTitle name="run" />
      </RowsGo>,
    );
    expect(html).toContain(
      '<div class="rows-line rows-line-end"><a class="rows-go rows-go-part" href="/x">',
    );
    expect(html).toContain("</a><button");
    expect(render(<RowsGo href="/x">y</RowsGo>)).toContain(
      '<a class="rows-line rows-go" href="/x">',
    );
  });

  test("an end that asks wraps, one of buttons alone does not", () => {
    expect(render(<RowsEnd words="Delete x?" />)).toContain(
      'class="rows-end rows-end-ask"><span class="rows-end-words">Delete x?',
    );
    expect(render(<RowsEnd error="refused" words="Delete x?" />)).toContain(
      '<span class="rows-end-error error" role="alert">refused</span>',
    );
    expect(render(<RowsEnd />)).toBe('<span class="rows-end"></span>');
  });

  test("a switch, a box with words and a line that cannot be picked", () => {
    const on = render(<RowsSwitch on label="webfetch" onClick={noop} />);
    expect(on).toContain('role="switch" aria-checked="true"');
    expect(on).toContain('aria-label="webfetch on"');
    const box = render(
      <RowsCheck name="read:x" checked faint note="off" onChange={noop}>
        Read
      </RowsCheck>,
    );
    expect(box).toContain(
      '<label class="rows-check rows-check-words rows-check-faint">',
    );
    expect(box).toContain("rows-check-box rows-check-on");
    expect(box).toContain('<span class="rows-check-note">off</span>');
    expect(
      render(
        <RowsLine as="label" flush off>
          <RowsCheck name="s" checked={false} onChange={noop} />
        </RowsLine>,
      ),
    ).toContain('<div class="rows-item rows-item-off"><label');
  });

  test("filters are links for an address, buttons for a pick", () => {
    const links = render(
      <RowsFilters
        label="Filter runs"
        filters={[
          { label: "All", on: true, href: "/a" },
          { label: "Failed", on: false, href: "/a?runs=failed" },
        ]}
      />,
    );
    expect(links).toContain(
      '<a class="seg-option seg-on" href="/a" aria-current="page">All</a>',
    );
    const buttons = render(
      <RowsFilters
        label="Show"
        filters={[{ label: "Chats", on: false, onPick: noop }]}
      />,
    );
    expect(buttons).toContain('aria-pressed="false">Chats</button>');
  });
});
