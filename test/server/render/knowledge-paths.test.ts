// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// /knowledge/ paths in rendered Markdown link to the project's files.

import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../../src/server/render/index.ts";

const P = "abc123def456";
const a = (name: string, label = `/knowledge/${name}`) =>
  `<a class="md-link md-path" href="/projects/${P}/knowledge/path?name=${encodeURIComponent(name)}">${label}</a>`;
const p = (html: string) => `<p class="md-p">${html}</p>`;

describe("knowledge paths", () => {
  test.each([
    ["/knowledge/x.md", p(a("x.md"))],
    ["see /knowledge/plans/x.md now", p(`see ${a("plans/x.md")} now`)],
    ["(/knowledge/x.md)", p(`(${a("x.md")})`)],
    ["read /knowledge/x.md.", p(`read ${a("x.md")}.`)],
    ["read /knowledge/x.md...", p(`read ${a("x.md")}...`)],
    [
      "/knowledge/a.md, /knowledge/b.md; and /knowledge/c-d_e.f!",
      p(`${a("a.md")}, ${a("b.md")}; and ${a("c-d_e.f")}!`),
    ],
    ["a /knowledge/a_b_c.md b", p(`a ${a("a_b_c.md")} b`)],
    ["line\n/knowledge/x.md", p(`line\n${a("x.md")}`)],
    [
      "**/knowledge/x.md**",
      p(`<strong class="md-strong">${a("x.md")}</strong>`),
    ],
    ["# /knowledge/x.md", `<h1 class="md-h1">${a("x.md")}</h1>`],
    ["[the plan](/knowledge/plans/x.md)", p(a("plans/x.md", "the plan"))],
    ["see (/knowledge/a.md).", p(`see (${a("a.md")}).`)],
    ["(/knowledge/a.md)", p(`(${a("a.md")})`)],
    ["a *(/knowledge/a.md)*", p(`a <em class="md-em">(${a("a.md")})</em>`)],
    ["- /knowledge/a.md", `<li class="md-li">${a("a.md")}</li>`],
    ["> /knowledge/a.md", `<blockquote class="md-quote">${p(a("a.md"))}`],
    ["| /knowledge/a.md |\n|:-|", `style="text-align:left">${a("a.md")}</th>`],
    [
      "[`code`](/knowledge/x.md)",
      p(a("x.md", '<code class="md-code">code</code>')),
    ],
  ])("links %j", (md, html) => {
    expect(renderMarkdown(md, { project: P })).toContain(html);
  });

  test.each([
    ["`/knowledge/x.md`", p('<code class="md-code">/knowledge/x.md</code>')],
    [
      "```\n/knowledge/x.md\n```",
      '<code class="md-block-code">/knowledge/x.md\n</code>',
    ],
    ["```ts\nconst a = '/knowledge/x.md';\n```", "&#x27;/knowledge/x.md&#x27;"],
    [
      "[about /knowledge/x.md](https://example.test)",
      p(
        '<a class="md-link" href="https://example.test" target="_blank" rel="noopener">about /knowledge/x.md</a>',
      ),
    ],
    ["[/knowledge/x.md](/tmp/y)", p("/knowledge/x.md")],
    [
      "https://example.test/knowledge/x.md",
      p("https://example.test/knowledge/x.md"),
    ],
    ["a/knowledge/x.md", p("a/knowledge/x.md")],
    ['"/knowledge/x.md"', p("&quot;/knowledge/x.md&quot;")],
    ["/tmp/x", p("/tmp/x")],
    ["/uploads/x.md /repos/r/x.md", p("/uploads/x.md /repos/r/x.md")],
    ["/knowledge/plans/", p("/knowledge/plans/")],
    ["/knowledge/", p("/knowledge/")],
    ["/knowledge/../x", p("/knowledge/../x")],
    ["/knowledge/a/./x", p("/knowledge/a/./x")],
    ["/knowledge/a%2Fb", p("/knowledge/a%2Fb")],
    ["http://h.com/_a_/knowledge/x.md", "</em>/knowledge/x.md</p>"],
    ["*foo*/knowledge/x.md", "</em>/knowledge/x.md</p>"],
    ["`code`/knowledge/x.md", "</code>/knowledge/x.md</p>"],
    ["[l](https://x)/knowledge/a.md", "</a>/knowledge/a.md</p>"],
    ["https://h.com/x(/knowledge/y.md)", p("https://h.com/x(/knowledge/y.md)")],
    ["x (a(/knowledge/y.md)", p("x (a(/knowledge/y.md)")],
    [
      `/knowledge/${".".repeat(100_000)}x`,
      p(`/knowledge/${".".repeat(100_000)}x`),
    ],
    [
      `/knowledge/${"a".repeat(100_000)}.md`,
      p(`/knowledge/${"a".repeat(100_000)}.md`),
    ],
    [
      `/knowledge/${"a/".repeat(50_000)}x`,
      p(`/knowledge/${"a/".repeat(50_000)}x`),
    ],
    [`${"(".repeat(50_000)}/knowledge/x.md`, "(/knowledge/x.md</p>"],
    ["/knowledge/café.md", p("/knowledge/café.md")],
    ["[x](/knowledge/a%2Fb)", p("x")],
    ["[x](/knowledge/../y)", p("x")],
    [`/knowledge/${"a".repeat(81)}`, p(`/knowledge/${"a".repeat(81)}`)],
    [
      `/knowledge/${"abcdefghi/".repeat(9)}x`,
      p(`/knowledge/${"abcdefghi/".repeat(9)}x`),
    ],
  ])("leaves %j as it was", (md, html) => {
    expect(renderMarkdown(md, { project: P })).toContain(html);
    expect(renderMarkdown(md, { project: P })).not.toContain("md-path");
  });

  test("a web address keeps its own link", () => {
    const html = renderMarkdown("go https://example.test/knowledge/x.md", {
      project: P,
      autolinks: true,
    });
    expect(html).toBe(
      p(
        'go <a class="md-link" href="https://example.test/knowledge/x.md" target="_blank" rel="noopener">https://example.test/knowledge/x.md</a>',
      ),
    );
  });

  test("without a project nothing links and the output is as before", () => {
    for (const md of [
      "see /knowledge/x.md and [plan](/knowledge/y.md)",
      "a /knowledge/a_b_c.md `/knowledge/x.md`",
      "```\n/knowledge/x.md\n```",
    ]) {
      const html = renderMarkdown(md);
      expect(html).not.toContain("md-path");
      expect(html).not.toContain("<kp>");
    }
    expect(renderMarkdown("[plan](/knowledge/y.md)")).toBe(p("plan"));
  });

  test("no mark is left in what renders", () => {
    const md =
      "a_b *c* `d` [e](/f) ![g](h) | t |\n|---|\n| /knowledge/x.md |\n\n```\nz\n```";
    expect(renderMarkdown(md, { project: P })).not.toMatch(/<\/?kp>/);
  });

  test("an explicit link keeps its title", () => {
    expect(
      renderMarkdown('[l](/knowledge/a.md "the plan")', { project: P }),
    ).toBe(
      p(
        `<a class="md-link md-path" href="/projects/${P}/knowledge/path?name=a.md" title="the plan">l</a>`,
      ),
    );
  });

  test("text naming no path renders as without a project", () => {
    const md =
      "# Plan\n\nSee *a* and `b`, [c](https://example.test) and /tmp/x.\n\n| t |\n|-|\n| u |\n\n```ts\nconst x = 1;\n```";
    expect(renderMarkdown(md, { project: P })).toBe(renderMarkdown(md));
    expect(renderMarkdown(md, { project: P, autolinks: true })).toBe(
      renderMarkdown(md, { autolinks: true }),
    );
  });

  test("the project is encoded into the link", () => {
    expect(renderMarkdown("/knowledge/x.md", { project: "a/b" })).toContain(
      'href="/projects/a%2Fb/knowledge/path?name=x.md"',
    );
  });
});
