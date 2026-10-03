// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Where a streaming reply's text may be cut for a render: only after a
// whole block, so rendered markdown never replaces raw text that is
// still growing.

import { expect, test } from "bun:test";
import { renderMarkdown, stableEnd } from "../../../src/server/render/index.ts";

// each case marks the expected end with a "¦", which the text lacks
const cases: [string, string][] = [
  ["no boundary yet", "¦A paragraph still growing"],
  ["a line not yet ended", "¦One line\nand another"],
  ["a paragraph then a blank line", "First paragraph.\n\n¦Second"],
  ["trailing blank lines", "Done.\n\n\n¦"],
  ["only the last boundary counts", "One.\n\nTwo.\n\n¦Thr"],
  ["CRLF line endings", "First.\r\n\r\n¦Second\r\nmore"],
  ["a list item waits on half a CRLF", "¦- a\r\n\r\n\r"],
  ["a blank line of spaces", "First.\n  \t\n¦Second"],
  ["a heading line", "# Title\n¦Intro text"],
  ["a heading after a paragraph", "Para\n## Next\n¦more"],
  ["a heading not yet ended", "Intro.\n\n¦## Tit"],
  ["an indented heading is not one", "¦- item\n  # sub\n"],
  ["a fence closed", "```js\nlet a = 1;\n```\n¦Then"],
  ["a fence closed after a paragraph", "Code:\n```\nx\n```\n¦"],
  ["a fence in progress", "Intro.\n\n```js\nlet a = 1;\n¦"],
  ["a blank line inside a fence", "Intro.\n\n```\na\n\nb\n¦"],
  ["a blank line inside a closed fence", "```\na\n\nb\n```\n¦after"],
  ["a tilde fence", "Intro.\n\n~~~\na\n\n```\n\n¦"],
  ["a tilde fence closed", "~~~\na\n\nb\n~~~\n\n¦x"],
  ["a longer fence needs as long a close", "````\na\n```\n\nb\n¦"],
  ["a longer fence closed by a longer one", "````\na\n```\n`````\n¦x"],
  ["a close with an info string is not one", "```\na\n```js\n\nb\n¦"],
  ["an unclosed fence", "Text.\n\n```python\nprint(1)\n\n\ndef f():\n¦"],
  ["an open fence ends at its last whole line", "```sh\nmake\n¦make te"],
  ["an open fence's first line alone", "Intro.\n\n¦```js\n"],
  ["an open fence under a paragraph", "Code:\n```\nx\n¦"],
  ["an indented fence under a paragraph is text", "¦Para\n    ```\n    x\n"],
  ["a fence in a quote stays whole", "¦> ```\n> a\n> b\n"],
  ["a CRLF fence", "```\r\na\r\n\r\n```\r\n¦x"],
  [
    "a fence inside a list item",
    "¦- step\n\n  ```sh\n  make\n\n  make test\n  ```\n\n",
  ],
  ["a fence on a list marker", "¦1. ```sh\n   make\n\n   make test\n"],
  ["a fence in a quote", "¦> ```\n> a\n\n"],
  ["a tight list ends at each item", "- a\n- b\n¦- c\n\n"],
  ["a list's first item waits", "¦- a\n  more of a\n"],
  ["an ordered list ends at each item", "1. a\n2. b\n¦3. c"],
  ["a nested item is not the list's", "- a\n¦- b\n  - n\n  - m\n"],
  ["an item after a nested list", "- a\n  - n\n¦- b\n"],
  ["an item marker inside a fence is code", "¦- a\n\n  ```\n- b\n"],
  ["a CRLF list item", "- a\r\n¦- b\r\n"],
  ["a new marker starts a new list", "- a\n¦* b\n"],
  ["an item under a paragraph ends it", "Para\n¦- a\n"],
  ["a rule is a whole block", "Para\n\n* * *\n¦x"],
  ["a rule under a paragraph", "Para\n***\n¦x"],
  ["a dash line under a paragraph is an underline", "¦Para\n---\nx"],
  ["a rule in a list ends it", "- a\n- - -\n¦x"],
  ["a rule inside an item is the item's", "¦- a\n\n  ***\n"],
  ["an item indented to the text is nested", "- a\n¦- b\n   - n\n"],
  ["a marker left of the item's text is a sibling", "1. a\n¦ 2. b\n"],
  ["a lone marker may be an underline", "- a\n¦- b\n- "],
  ["a tight list ends at the next block", "- a\n- b\n\n¦Then"],
  ["a loose list ends at each item", "- a\n\n¦- b\n\n"],
  ["a loose list ends at the next block", "- a\n\n- b\n\n¦After"],
  ["a list item's second paragraph", "¦1. a\n\n   more\n\n"],
  ["a list waits on a line that may be an item", "¦1. a\n\n2"],
  ["a list after a paragraph", "Para.\n\n- a\n\n¦- b\n"],
  [
    "a list under a paragraph line",
    "To build:\n1. Install:\n\n   ```sh\n   make\n   ```\n\n¦2. Run: it\n",
  ],
  ["a bullet list under a paragraph line", "Options:\n- a\n- b\n\n¦- c\n"],
  [
    "a list item's paragraph under a paragraph",
    "Steps:\n1. a\n¦2. b\n\n   more on b\n",
  ],
  ["a list under a paragraph ends", "Options:\n- a\n\n¦Then"],
  ["an ordered list not at 1 is the paragraph's", "Para\n2. a\n\n¦x"],
  ["a table in progress", "Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n¦| 3"],
  ["a table's header alone", "Intro.\n\n¦| a | b |\n"],
  ["a table's delimiter row", "| a | b |\n|:--|--:|\n¦| 1"],
  ["a table without outer pipes", "a | b\n--- | ---\n1 | 2\n¦"],
  ["a delimiter that does not match the header", "¦| a | b |\n|---|\n| 1 |\n"],
  ["a header under a paragraph line is text", "¦Para\n| a | b |\n|---|---|\n"],
  ["a CRLF table", "| a |\r\n|---|\r\n| 1 |\r\n¦| 2"],
  [
    "a rule after a table ends it",
    "| a | b |\n|---|---|\n| 1 | 2 |\n---\n¦more\n===\n",
  ],
  [
    "a quote after a table ends it",
    "| a | b |\n|---|---|\n| 1 | 2 |\n¦> **x\ny**\n",
  ],
  [
    "indented code after a table ends it",
    "| a | b |\n|---|---|\n| 1 | 2 |\n¦    code\nmore **x\ny**\n",
  ],
  ["a list after a table ends it", "| a |\n|---|\n| 1 |\n¦2. a\nlazy\n"],
  ["a fence line in a table is a row", "| a |\n|---|\n| 1 |\n```\n\n¦more **x"],
  ["a heading line in a table is a row", "| a |\n|---|\n| 1 |\n# h\n¦x"],
  [
    "a header with space after its last pipe is text",
    "¦| a | b | \n|---|---|\n| 1 | 2 |\n",
  ],
  ["a delimiter with space after its last pipe", "| a | b |\n|---|---| \n¦x"],
  ["an escaped backslash leaves the pipe real", "a \\\\| b\n--- | ---\n¦x"],
  ["an escaped pipe is not a cell", "a \\| b | c\n--- | ---\n¦x"],
  ["three backslashes escape the pipe", "a \\\\\\| b | c\n--- | ---\n¦x"],
  ["a quoted table is the quote's", "¦> | a | b |\n> |---|---|\n> | 1 | 2 |\n"],
  ["a partial rule is not an item", "- a\n¦- b\n* *"],
  ["a partial dash rule is not an item", "- a\n¦- b\n- -"],
  ["a line left of the item's text ends the list", "1. one\n\n¦  more\n-\n"],
  ["an empty marker after an item is a sibling", "Para\n\n- a\n  more\n¦-\n"],
  ["a header of dashes is not one", "¦--- | ---\n|:-|-:|\n"],
  ["a table ended", "| a | b |\n|---|---|\n| 1 | 2 |\n\n¦x"],
  ["indented code waits", "Para.\n\n¦    code\n\n    more\n\n"],
  ["indented code ends at the next block", "    code\n\n¦Text"],
];

for (const [name, marked] of cases) {
  test(name, () => {
    const at = marked.indexOf("¦");
    const content = marked.slice(0, at) + marked.slice(at + 1);
    expect(stableEnd(content)).toBe(at);
  });
}

// a cut inside an open fence renders the lines so far as the same code
// block, and a cut inside a list or table closes it early, so only the
// closing markup may differ from the whole render's
function head(html: string): string {
  const close = html.lastIndexOf("</code></pre>");
  const open = close === -1 ? html : html.slice(0, close);
  return open.replace(/(?:<\/[a-z0-9]+>)+$/, "");
}

// a tight list turns loose at a blank line between later items and
// wraps every item in a paragraph; the only markup a cut may lose
const LOOSE = /<li[^>]*>(?:<input[^>]*> )?<p/;
const tight = (html: string): string =>
  html.replace(/<\/?p( class="md-p")?>/g, "");

export function opensWhole(whole: string, cut: string): boolean {
  if (whole.startsWith(cut) || whole.startsWith(head(cut))) return true;
  return LOOSE.test(whole) && tight(whole).startsWith(tight(head(cut)));
}

test("the end never moves back as the text grows", () => {
  for (const [name, marked] of cases) {
    const content = marked.replace("¦", "");
    let last = 0;
    let back = false;
    for (let i = 0; i <= content.length; i++) {
      const end = stableEnd(content.slice(0, i));
      if (end < last) back = true;
      last = end;
    }
    expect({ name, back }).toEqual({ name, back: false });
  }
});

test("a rendered cut opens the whole text's render", () => {
  for (const [name, marked] of cases) {
    const content = marked.replace("¦", "");
    const whole = renderMarkdown(content);
    const cut = renderMarkdown(content.slice(0, stableEnd(content)));
    const opens = opensWhole(whole, cut);
    expect({ name, opens }).toEqual({ name, opens: true });
  }
});

test("a list that turns loose is the one markup a cut loses", () => {
  const content = "- a\n- b\n\n- c\n";
  const cut = renderMarkdown(content.slice(0, stableEnd("- a\n- b\n")));
  expect(renderMarkdown(content).startsWith(head(cut))).toBe(false);
  expect(opensWhole(renderMarkdown(content), cut)).toBe(true);
});

test("the empty reply has no boundary", () => {
  expect(stableEnd("")).toBe(0);
});
