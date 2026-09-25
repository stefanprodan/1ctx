// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A folder tree as rows: a folder a disclosure button with its count,
// its rows only while open and a level deeper; a file a link with its
// meta; Show more at a folder's end.

import { expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { RowsTree, type RowsTreeNode } from "../../../src/client/ui/Rows.tsx";

const noop = () => {};

const tree = (open: boolean): RowsTreeNode[] => [
  {
    kind: "folder",
    key: "plans",
    name: "plans",
    count: 1234,
    open,
    onToggle: noop,
    children: [
      {
        kind: "file",
        key: "f1",
        name: "a.md",
        href: "/k/f1",
        meta: "2d ago",
        lit: true,
        title: "plans/a.md",
      },
      {
        kind: "more",
        key: "more",
        label: "Show 12 more in plans",
        onPick: noop,
      },
    ],
  },
  { kind: "file", key: "f2", name: "readme.md", href: "/k/f2" },
];

test("a closed folder is a button with its count and no rows under it", () => {
  const html = render(<RowsTree label="Files" nodes={tree(false)} />);
  expect(html).toContain('<ul class="rows-tree" aria-label="Files">');
  expect(html).toContain(
    '<button type="button" class="rows-tree-node rows-tree-folder" style="--rows-depth:0;" aria-expanded="false">',
  );
  expect(html).toContain('<span class="rows-tree-meta">1.23K files</span>');
  expect(html).not.toContain("a.md");
  // a file with no meta draws none
  expect(html).toContain(
    '<span class="rows-tree-name">readme.md</span></a></li></ul>',
  );
});

test("an open folder draws its rows a level deeper, the lit meta and Show more", () => {
  const html = render(<RowsTree label="Files" nodes={tree(true)} />);
  expect(html).toMatch(/aria-expanded="true" aria-controls="([^"]+)"/);
  const id = html.match(/aria-controls="([^"]+)"/)![1];
  expect(html).toContain(`<ul class="rows-tree" id="${id}">`);
  expect(html).toContain(
    '<a class="rows-tree-node rows-tree-file" style="--rows-depth:1;" href="/k/f1" title="plans/a.md">',
  );
  expect(html).toContain(
    '<span class="rows-tree-meta rows-tree-lit">2d ago</span>',
  );
  expect(html).toContain(
    '<button type="button" class="rows-tree-node rows-tree-more" style="--rows-depth:1;"><span class="rows-tree-gap"></span>Show 12 more in plans</button>',
  );
  expect(html).toContain("rows-tree-chevron rows-tree-chevron-open");
});

test("one file is counted as a file", () => {
  const html = render(
    <RowsTree
      label="Files"
      nodes={[
        {
          kind: "folder",
          key: "a",
          name: "a",
          count: 1,
          open: false,
          onToggle: noop,
          children: [],
        },
      ]}
    />,
  );
  expect(html).toContain('<span class="rows-tree-meta">1 file</span>');
});
