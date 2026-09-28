// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { render } from "preact-render-to-string";
import { Finder } from "../../../src/client/ui/Finder.tsx";
import { ListboxSearch } from "../../../src/client/ui/Listbox.tsx";
import { PageNew, PageSwitcher } from "../../../src/client/ui/Page.tsx";
import { RowsEnd, RowsMeta, RowsRemove } from "../../../src/client/ui/Rows.tsx";
import { Search } from "../../../src/client/ui/Search.tsx";
import { AsideRead } from "../../../src/client/ui/Split.tsx";

const plain = (html: string) => html.replaceAll("<!-- -->", "");
const strip = (html: string) => plain(html).replace(/<svg.*?<\/svg>/g, "");

describe("PageSwitcher", () => {
  const items = [
    { id: "a", label: "@alpha", href: "/a" },
    { id: "b", label: "@beta", href: "/b" },
  ];

  test("alone it is the crumb's own step, mono unless told", () => {
    expect(
      render(
        <PageSwitcher
          label="Agents"
          current="a"
          name="@alpha"
          items={items.slice(0, 1)}
          placeholder="Find an agent"
          none="No agent matches"
        />,
      ),
    ).toBe('<span class="page-crumb-on page-crumb-path">@alpha</span>');
    expect(
      render(
        <PageSwitcher
          label="Decisions"
          current="a"
          name="Title"
          items={[]}
          mono={false}
          placeholder="Find a decision"
          none="No decision matches"
        />,
      ),
    ).toBe('<span class="page-crumb-on">Title</span>');
  });

  test("with siblings it is a pill that opens them", () => {
    expect(
      strip(
        render(
          <PageSwitcher
            label="Agents"
            current="a"
            name="@alpha"
            items={items}
            placeholder="Find an agent"
            none="No agent matches"
          />,
        ),
      ),
    ).toBe(
      '<div class="finder"><button type="button" class="page-pill" title="@alpha" aria-haspopup="menu" aria-expanded="false"><span class="cut">@alpha</span></button></div>',
    );
  });
});

test("PageNew is the head's small button with a plus", () => {
  expect(strip(render(<PageNew href="/x?new" label="New server" />))).toBe(
    '<a class="btn btn-small" href="/x?new">New server</a>',
  );
});

test("a Finder's add draws the plus and its words as the trigger", () => {
  const html = plain(
    render(
      <Finder
        label="Skills"
        add="Add skill"
        options={[]}
        placeholder="Find a skill"
        none="No skill matches"
      />,
    ),
  );
  expect(html).toContain('<svg width="14" height="14"');
  expect(strip(html)).toBe(
    '<div class="finder"><button type="button" class="btn btn-small" aria-haspopup="menu" aria-expanded="false">Add skill</button></div>',
  );
});

describe("AsideRead", () => {
  const read = (value: number | null | undefined) =>
    render(
      <AsideRead label="Last 30 days" value={value}>
        {(n) => <p>{n}</p>}
      </AsideRead>,
    );
  const head =
    '<section class="split-section"><div class="split-section-head"><span class="label">Last 30 days</span></div>';

  test("loading, failed, then the lines", () => {
    expect(read(undefined)).toBe(
      `${head}<p class="split-empty">Loading</p></section>`,
    );
    expect(read(null)).toBe(
      `${head}<p class="split-empty">Did not load.</p></section>`,
    );
    expect(read(0)).toBe(`${head}<p>0</p></section>`);
  });
});

describe("rows parts", () => {
  test("a meta with a line under it", () => {
    expect(
      render(
        <RowsMeta keep under="read on">
          2 agents
        </RowsMeta>,
      ),
    ).toBe(
      '<span class="rows-meta rows-meta-keep"><span class="rows-meta-two"><span>2 agents</span><span class="rows-meta-under">read on</span></span></span>',
    );
  });

  test("the remove X names what it removes", () => {
    expect(
      strip(
        render(
          <RowsEnd>
            <RowsRemove name="@casey" disabled onRemove={() => {}} />
          </RowsEnd>,
        ),
      ),
    ).toBe(
      '<span class="rows-end"><button type="button" class="btn-icon rows-remove" aria-label="Remove @casey" title="Remove" disabled></button></span>',
    );
  });
});

test("a search box takes its query from a signal or a value", () => {
  const q = signal("flux");
  expect(render(<Search query={q} placeholder="Search servers" />)).toContain(
    'value="flux"',
  );
  expect(
    render(<Search value="sre" onChange={() => {}} placeholder="Search" />),
  ).toContain('value="sre"');
});

test("a listbox search is the glass and a combobox input", () => {
  expect(
    strip(
      render(
        <ListboxSearch inputRef={{ current: null }} name="find" value="a" />,
      ),
    ),
  ).toBe(
    '<div class="listbox-search"><input class="listbox-input" type="text" role="combobox" aria-expanded="true" autocomplete="off" spellcheck="false" name="find" value="a"/></div>',
  );
});
