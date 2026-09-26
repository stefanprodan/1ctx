// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A page with head actions or a notice over a Split passes split, or
// its buttons sit at the far right over the aside on a wide screen.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";

const VIEWS = join(import.meta.dir, "../../../src/client/views");

// each <Page ...> opening tag of a source, up to the > that closes it
// on its own line, and what follows up to the page's close
function pages(source: string): { props: string; body: string }[] {
  const out: { props: string; body: string }[] = [];
  const open = /<Page\b([\s\S]*?)\n(\s*)>\n/g;
  for (const m of source.matchAll(open)) {
    const start = (m.index ?? 0) + m[0].length;
    const end = source.indexOf("</Page>", start);
    out.push({
      props: m[1] ?? "",
      body: source.slice(start, end === -1 ? undefined : end),
    });
  }
  return out;
}

function missingSplit(source: string): number {
  return pages(source).filter(
    ({ props, body }) =>
      /\n\s*(actions|notice)=/.test(props) &&
      body.includes("<Split") &&
      !/\n\s*split(\n|=|$)/.test(props),
  ).length;
}

test("the check sees a page with actions over a Split", () => {
  const page = (split: string) =>
    `<Page\n  title="x"\n  actions={<b />}\n${split}>\n  <Split aside={1}>y</Split>\n</Page>`;
  expect(missingSplit(page(""))).toBe(1);
  expect(missingSplit(page("  split\n"))).toBe(0);
  // no actions, nothing over the aside
  expect(
    missingSplit(
      `<Page\n  title="x"\n>\n  <Split aside={1}>y</Split>\n</Page>`,
    ),
  ).toBe(0);
});

test("every view with head actions over a Split passes split", async () => {
  const bad: string[] = [];
  for await (const file of new Glob("**/*.tsx").scan(VIEWS)) {
    const source = await Bun.file(join(VIEWS, file)).text();
    if (missingSplit(source) > 0) bad.push(file);
  }
  expect(bad).toEqual([]);
});
