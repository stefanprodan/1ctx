// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent's Markdown in an email: a link shows its address, never its
// label; an image and a raw HTML block are dropped; everything else is
// escaped, and the plain text says the same.

import { describe, expect, test } from "bun:test";
import { renderEmailMarkdown } from "../../../src/server/render/index.ts";

describe("the email renderer", () => {
  test("writes a link as its full address, never its label", () => {
    const { html, text } = renderEmailMarkdown(
      "Open [your bank](https://evil.test/login?a=1&b=2) now.",
    );
    expect(html).toBe(
      '<p>Open <a href="https://evil.test/login?a=1&amp;b=2">https://evil.test/login?a=1&amp;b=2</a> now.</p>',
    );
    expect(text).toBe("Open https://evil.test/login?a=1&b=2 now.");
    expect(html).not.toContain("your bank");
    expect(text).not.toContain("your bank");
  });

  test("links only http and https, and shows any other address as text", () => {
    const { html, text } = renderEmailMarkdown(
      "[a](javascript:alert(1)) [b](mailto:x@example.test)",
    );
    expect(html).toBe("<p>javascript:alert(1) mailto:x@example.test</p>");
    expect(html).not.toContain("<a");
    expect(text).toBe("javascript:alert(1) mailto:x@example.test");
  });

  test("drops images and raw HTML blocks, and escapes a span", () => {
    const { html, text } = renderEmailMarkdown(
      [
        "![tracker](https://img.test/p.png)",
        '<div onclick="x"><script>alert(1)</script></div>',
        "Hi <b>there</b> & x < y",
      ].join("\n\n"),
    );
    expect(html).toBe("<p>Hi &lt;b&gt;there&lt;/b&gt; &amp; x &lt; y</p>");
    expect(html).not.toContain("img.test");
    expect(text).toBe("Hi <b>there</b> & x < y");
  });

  test("keeps the structure in both parts, with no class or style", () => {
    const md = [
      "# Report",
      "**Bold** and `code`.",
      "- one\n- two\n  - nested\n- [x] done",
      "3. c\n4. d",
      "> quoted\n> line",
      '```js\nlet a = "<x>";\n```',
      "| a | b |\n|---|---|\n| 1 | 2 |",
    ].join("\n\n");
    const { html, text } = renderEmailMarkdown(md);
    expect(html).toContain("<h1>Report</h1>");
    expect(html).toContain("<strong>Bold</strong> and <code>code</code>");
    expect(html).toContain("<li>two<ul><li>nested</li></ul></li>");
    expect(html).toContain("<li>[x] done</li>");
    expect(html).toContain('<ol start="3">');
    expect(html).toContain(
      "<pre><code>let a = &quot;&lt;x&gt;&quot;;\n</code></pre>",
    );
    expect(html).toContain("<td>1</td><td>2</td>");
    expect(html).not.toMatch(/class=|style=|<script/);
    expect(text).toBe(
      [
        "Report",
        "Bold and code.",
        "- one\n- two\n  - nested\n- [x] done",
        "3. c\n4. d",
        "> quoted\n> line",
        'let a = "<x>";',
        "a | b\n1 | 2",
      ].join("\n\n"),
    );
  });

  test("an empty body is empty", () => {
    expect(renderEmailMarkdown("  \n")).toEqual({ html: "", text: "" });
  });
});
