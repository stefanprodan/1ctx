// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A cut block: the fade and Show all only while the cut hides
// something, the ground the fade ends in, the frame a boxed block
// needs, and the words.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { showAll } from "../../../src/client/lib/format.ts";
import { Fold } from "../../../src/client/ui/Fold.tsx";

describe("a cut block", () => {
  test("draws the fade and Show all inside the block while cut", () => {
    const html = render(
      <Fold cut onOpen={() => {}} label="Show all 40 lines" framed>
        <pre class="textbox">text</pre>
      </Fold>,
    );
    expect(html).toBe(
      '<div class="fold fold-inset fold-framed" tabindex="-1">' +
        '<pre class="textbox">text</pre><div class="fold-more">' +
        '<button type="button" class="btn-text">Show all 40 lines</button>' +
        "</div></div>",
    );
  });

  test("draws the block alone once whole, on the ground it names", () => {
    const html = render(
      <Fold cut={false} onOpen={() => {}} label="Show all" ground="card">
        <pre>text</pre>
      </Fold>,
    );
    expect(html).toBe(
      '<div class="fold fold-card" tabindex="-1"><pre>text</pre></div>',
    );
  });

  test("says how many lines Show all opens", () => {
    expect(showAll(21)).toBe("Show all 21 lines");
    expect(showAll(1)).toBe("Show all 1 line");
  });
});
