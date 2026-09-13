// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Safe server-side Markdown markup for chat replies.

import { describe, expect, test } from "bun:test";
import {
  escapeHtml,
  renderMarkdown,
  tableAlign,
} from "../../../src/server/render/index.ts";

describe("renderMarkdown", () => {
  test("empty input renders nothing", () => {
    expect(renderMarkdown("")).toBe("");
  });

  test("escapes scripts and raw HTML blocks and spans", () => {
    const html = renderMarkdown(
      '<script>alert("x")</script>\n\n<div>block</div>\n\nA <b>span</b>',
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<div>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;div&gt;block&lt;/div&gt;");
    expect(html).toContain("A &lt;b&gt;span&lt;/b&gt;");
  });

  test("drops unsafe links and retains safe link attributes", () => {
    const html = renderMarkdown(
      '[bad](javascript:alert(1)) [good](http://example.test "title")',
    );
    expect(html).not.toContain("javascript:");
    expect(html).toContain("bad");
    expect(html).toContain(
      '<a class="md-link" href="http://example.test" title="title" target="_blank" rel="noopener">good</a>',
    );
  });

  test("renders images as text without an img element", () => {
    const html = renderMarkdown("![logo](https://example.test/logo.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain(
      '<span class="md-img">[image: logo https://example.test/logo.png]</span>',
    );
  });

  test("highlights a fenced TypeScript block", () => {
    const html = renderMarkdown("```ts\nconst value = 1;\n```");
    expect(html).toContain('<div class="md-block" data-lang="ts">');
    expect(html).toContain('<code class="md-block-code">');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
  });

  test("highlights JSON and escapes its string content", () => {
    const json = JSON.stringify({ description: "a < b & c" }, null, 2);
    const html = renderMarkdown(`\`\`\`json\n${json}\n\`\`\``);
    expect(html).toContain('<div class="md-block" data-lang="json">');
    expect(html).toContain('<span class="md-block-lang">json</span>');
    expect(html).toContain(
      '<button type="button" class="md-copy" title="Copy" aria-label="Copy block"><svg',
    );
    expect(html).toContain('class="md-copy-icon"');
    expect(html).toContain('class="md-copy-done"');
    expect(html).toContain(
      '<span class="hljs-attr">&quot;description&quot;</span>',
    );
    expect(html).toContain("a &lt; b &amp; c");
    expect(html).not.toContain("a < b & c");
  });

  test("leaves an unknown fenced language escaped", () => {
    const html = renderMarkdown("```unknown\nvalue < tag\n```");
    expect(html).toContain('data-lang="unknown"');
    expect(html).toContain(
      '<code class="md-block-code">value &lt; tag\n</code>',
    );
    expect(html).not.toContain("hljs-");
  });

  test("renders Mermaid as a plain code block", () => {
    const html = renderMarkdown("```mermaid\ngraph LR\nA --> B\n```");
    expect(html).toContain('<div class="md-block" data-lang="mermaid">');
    expect(html).toContain("graph LR\nA --&gt; B");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("hljs-");
    expect(renderMarkdown("```mermaid\ngraph LR\n```", true)).toContain(
      'data-lang="mermaid"',
    );
  });

  test("wraps and aligns tables", () => {
    const html = renderMarkdown("| a | b |\n|:--|--:|\n| 1 | 2 |");
    expect(html).toContain(
      '<div class="md-table-wrap"><table class="md-table">',
    );
    expect(html).toContain('<th class="md-th" style="text-align:left">a</th>');
    expect(html).toContain('<td class="md-td" style="text-align:right">2</td>');
  });

  test("allows only known table alignments", () => {
    expect(tableAlign("center")).toBe(' style="text-align:center"');
    expect(tableAlign("start")).toBe("");
    expect(tableAlign(undefined)).toBe("");
  });

  test("renders task and ordered lists", () => {
    const tasks = renderMarkdown("- [x] done\n- [ ] todo");
    expect(tasks).toContain(
      '<li class="md-li md-task"><input class="md-check" type="checkbox" disabled checked> done</li>',
    );
    expect(tasks).toContain(
      '<li class="md-li md-task"><input class="md-check" type="checkbox" disabled> todo</li>',
    );
    expect(renderMarkdown("3. three\n4. four")).toContain(
      '<ol class="md-ol" start="3">',
    );
  });

  test("renders heading classes for each level", () => {
    const html = renderMarkdown("# One\n\n### Three");
    expect(html).toContain('<h1 class="md-h1">One</h1>');
    expect(html).toContain('<h3 class="md-h3">Three</h3>');
  });

  test("escapes the four HTML-sensitive characters", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;",
    );
  });

  test("gives every renderer-owned opening tag an md class", () => {
    const html = renderMarkdown(
      [
        "# Heading",
        "",
        "Text **bold** *em* ~~gone~~ `code` [link](https://example.test) ![alt](x)",
        "",
        "> quote",
        "",
        "---",
        "",
        "- [x] task",
        "- item",
        "",
        "3. third",
        "",
        "```unknown",
        "plain",
        "```",
        "",
        "| a |",
        "|:-|",
        "| b |",
      ].join("\n"),
    );
    const tags = html.match(/<[a-z][^<>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      if (tag.startsWith("<input ")) continue;
      expect(tag).toMatch(/ class="md-/);
    }
  });
});
