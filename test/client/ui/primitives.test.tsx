// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The small shared parts: the status tag, a list's failure, an aside
// fact, the segmented switch, a board's bones and meters, and the ask
// before a delete.

import { describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { render } from "preact-render-to-string";
import { shareWidth } from "../../../src/client/lib/format.ts";
import { ChartPanel, Meter } from "../../../src/client/ui/Chart.tsx";
import { CodeTag } from "../../../src/client/ui/CodeTag.tsx";
import { AskDelete } from "../../../src/client/ui/Foot.tsx";
import { RowsFailed } from "../../../src/client/ui/Rows.tsx";
import { Seg } from "../../../src/client/ui/Seg.tsx";
import { AsideLine } from "../../../src/client/ui/Split.tsx";
import { TileMeter, TilesGhost } from "../../../src/client/ui/Tiles.tsx";

const noop = () => {};
const plain = (html: string) => html.replaceAll("<!-- -->", "");

describe("CodeTag", () => {
  test("draws the status, and nothing without one", () => {
    expect(plain(render(<CodeTag status={409} />))).toBe(
      '<span class="code-tag">HTTP 409</span>',
    );
    expect(plain(render(<CodeTag status={500} spaced class="x" />))).toBe(
      ' <span class="code-tag x">HTTP 500</span>',
    );
    expect(render(<CodeTag status={null} spaced />)).toBe("");
    expect(render(<CodeTag status={undefined} />)).toBe("");
  });
});

test("a list's failure is its words, then the status", () => {
  expect(
    plain(render(<RowsFailed failure={{ words: "busy", status: 503 }} />)),
  ).toBe(
    '<div class="rows-item rows-block"><p class="notice-failed" role="alert">Busy. <span class="code-tag">HTTP 503</span></p></div>',
  );
  expect(
    render(<RowsFailed failure={{ words: "offline", status: null }} />),
  ).toBe(
    '<div class="rows-item rows-block"><p class="notice-failed" role="alert">Offline.</p></div>',
  );
});

test("an aside fact is its label, then the value, cut or linked", () => {
  expect(render(<AsideLine label="Role">Admin</AsideLine>)).toBe(
    '<div class="split-line">Role<span class="split-strong">Admin</span></div>',
  );
  expect(
    render(
      <AsideLine label="Email" cut href="mailto:a@b.c">
        a@b.c
      </AsideLine>,
    ),
  ).toBe(
    '<div class="split-line">Email<a class="split-strong cut" href="mailto:a@b.c">a@b.c</a></div>',
  );
});

test("a segmented switch presses the picked option and names it", () => {
  expect(
    render(
      <Seg
        label="Show"
        small
        invalid
        name="memory"
        class="own"
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B", disabled: true },
        ]}
        value="a"
        onPick={noop}
      />,
    ),
  ).toBe(
    '<fieldset class="seg seg-small seg-invalid own" aria-label="Show"><button type="button" name="memory" class="seg-option seg-on" aria-pressed="true">A</button><button type="button" class="seg-option" aria-pressed="false" disabled>B</button></fieldset>',
  );
});

describe("the board's parts", () => {
  test("a share is a clamped width", () => {
    expect(shareWidth(0.5)).toBe("50.0%");
    expect(shareWidth(-1)).toBe("0.0%");
    expect(shareWidth(2)).toBe("100.0%");
    expect(render(<Meter share={0.25} />)).toContain('style="width:25.0%;"');
    expect(render(<TileMeter share={1} full />)).toBe(
      '<span class="meter tiles-meter" aria-hidden="true"><span class="meter-fill tiles-meter-fill tiles-meter-full" style="width:100.0%;"></span></span>',
    );
  });

  test("a row of tile bones is four tiles, their pulse from at", () => {
    const html = render(<TilesGhost at={16} />);
    expect(html.startsWith('<div class="tiles">')).toBe(true);
    expect(html.match(/tiles-ghost/g)?.length).toBe(4);
  });

  test("a panel is a card of rows with a live hint", () => {
    const html = render(
      <ChartPanel label="Areas" hint="4 MB">
        <p>x</p>
      </ChartPanel>,
    );
    expect(html).toMatch(
      /^<section class="card rows-card chart-panel" aria-labelledby="[^"]+"><div class="rows-head"><span class="label" id="[^"]+">Areas<\/span><span class="rows-hint cut" aria-live="polite">4 MB<\/span><\/div><p>x<\/p><\/section>$/,
    );
  });
});

describe("AskDelete", () => {
  const save = { pending: signal<string | null>(null), touch: noop };

  test("Delete alone until it asks", () => {
    expect(
      render(
        <AskDelete
          save={save}
          asking={signal(false)}
          busy
          words="Delete a?"
          onDelete={noop}
        />,
      ),
    ).toBe('<button type="button" class="btn" disabled>Delete</button>');
  });

  test("the ask: the owner's words, the danger button and Keep", () => {
    expect(
      render(
        <AskDelete
          save={save}
          asking={signal(true)}
          busy={false}
          words="Delete a?"
          wordsClass="mcp-ask"
          onDelete={noop}
        />,
      ),
    ).toBe(
      '<span class="mcp-ask">Delete a?</span><button type="button" class="btn btn-danger">Delete</button><button type="button" class="btn">Keep</button>',
    );
    const deleting = { pending: signal<string | null>("delete"), touch: noop };
    expect(
      render(
        <AskDelete
          save={deleting}
          asking={signal(true)}
          busy
          label="Delete with 3 chats"
          onDelete={noop}
        />,
      ),
    ).toBe(
      '<button type="button" class="btn btn-danger" disabled>Deleting</button><button type="button" class="btn" disabled>Keep</button>',
    );
  });
});
