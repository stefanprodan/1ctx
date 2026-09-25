// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A text by its numbered lines: highlighted or plain, numbers as links
// when the view gives the address, the lit line marked.

import { expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Source } from "../../../src/client/ui/Source.tsx";

test("plain text is escaped, a line a row, the final newline no row", () => {
  const html = render(<Source text={"<b>&\n\nend\n"} />);
  expect(html).toBe(
    '<div class="source">' +
      '<span class="source-num" aria-hidden="true">1</span><span class="source-text">&lt;b>&amp;</span>' +
      '<span class="source-num" aria-hidden="true">2</span><span class="source-text"></span>' +
      '<span class="source-num" aria-hidden="true">3</span><span class="source-text">end</span>' +
      "</div>",
  );
});

test("highlighted HTML is cut at its newlines, each line balanced", () => {
  const html = render(
    <Source
      text={"/* a\nb */\nx\n"}
      html={'<span class="hljs-comment">/* a\nb */</span>\nx\n'}
    />,
  );
  expect(html).toContain('<div class="source">');
  expect(html).toContain(
    '<span class="source-text"><span class="hljs-comment">/* a</span></span>',
  );
  expect(html).toContain(
    '<span class="source-text"><span class="hljs-comment">b */</span></span>',
  );
  // the text sets the count, not a trailing empty line of the HTML
  expect(html.match(/source-num/g)).toHaveLength(3);
});

test("numbers link where the view says, and the lit line is marked", () => {
  const html = render(
    <Source text={"a\nb\nc"} lit={2} lineHref={(n) => `?line=${n}`} />,
  );
  expect(html).toContain('<a class="source-num" href="?line=1">1</a>');
  expect(html).toContain(
    '<a class="source-num source-lit" href="?line=2" aria-current="location">2</a><span class="source-text source-lit">b</span>',
  );
});

test("a few thousand lines draw in one pass", () => {
  const text = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
  const html = render(<Source text={text} lineHref={(n) => `?line=${n}`} />);
  expect(html.match(/class="source-num"/g)).toHaveLength(5000);
  expect(html).toContain('href="?line=5000">5000</a>');
});
