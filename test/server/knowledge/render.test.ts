// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  MAX_RENDER_BYTES,
  RenderCache,
  rendered,
} from "../../../src/server/knowledge/render.ts";
import { MAX_BYTES } from "../../../src/server/render/index.ts";
import { setup } from "./helpers.ts";

describe("knowledge rendering", () => {
  test("renders Markdown and names its language", () => {
    const view = rendered("docs/Read.MD", "# Title\n\nsome *text*\n");
    expect(view.language).toBe("markdown");
    expect(view.html).toContain('class="md-h1"');
    expect(view.html).toContain("<em");
  });

  test("highlights code by its extension", () => {
    const view = rendered("src/a.ts", "const a = 1;\n");
    expect(view).toMatchObject({ language: "typescript", html: null });
    expect(view.code).toContain('class="hljs-keyword"');
  });

  test.each([
    ["page.html", "xml"],
    ["page.htm", "xml"],
    ["conf.yml", "yaml"],
  ])("gives %s the language %s", (name, language) => {
    const view = rendered(name, "<p>x</p>\n");
    expect(view.language).toBe(language);
    expect(view.code).not.toBeNull();
  });

  test("leaves an unknown extension and a name without one plain", () => {
    for (const name of ["notes.txt", "README", "data.weird"]) {
      expect(rendered(name, "<b>x</b>")).toEqual({
        language: null,
        html: null,
        code: null,
      });
    }
  });

  test("leaves code past the highlighter's size plain", () => {
    const text = "const a = 1;\n".repeat(Math.ceil(MAX_BYTES / 13) + 1);
    expect(rendered("a.ts", text)).toEqual({
      language: "typescript",
      html: null,
      code: null,
    });
  });

  test("a delete's version renders nothing", () => {
    expect(rendered("a.md", "", true)).toEqual({
      language: "markdown",
      html: null,
      code: null,
    });
  });

  test("the file and version details carry the rendering", () => {
    const s = setup();
    try {
      const file = s.area.create(s.projectId, s.author, "a.ts", "let x = 1;\n");
      expect(s.area.read(s.projectId, file.id)).toMatchObject({
        text: "let x = 1;\n",
        language: "typescript",
        html: null,
      });
      expect(s.area.read(s.projectId, file.id).code).toContain("hljs-");
      s.area.remove(s.projectId, s.author, file.id);
      const [gone, live] = s.area.versions(s.projectId, file.id);
      expect(s.area.version(s.projectId, gone!.id)).toMatchObject({
        deleted: true,
        language: "typescript",
        html: null,
        code: null,
      });
      expect(s.area.version(s.projectId, live!.id).code).toContain("hljs-");
    } finally {
      s.db.close();
    }
  });
  test("leaves Markdown past the render cap as source", () => {
    const text = "word ".repeat(Math.ceil(MAX_RENDER_BYTES / 5) + 1);
    expect(rendered("big.md", text).html).toBeNull();
    expect(rendered("fits.md", text.slice(0, MAX_RENDER_BYTES)).html).toContain(
      "md-p",
    );
  });

  test("keeps a view per revision and renders again after a write", () => {
    const s = setup();
    try {
      const file = s.area.create(s.projectId, s.author, "a.md", "# One\n");
      const first = s.area.read(s.projectId, file.id);
      const again = s.area.read(s.projectId, file.id);
      expect(again.html).toBe(first.html!);
      s.area.replace(s.projectId, s.author, file.id, "# Two\n", 1);
      expect(s.area.read(s.projectId, file.id).html).toContain("Two");
      s.area.rename(s.projectId, s.author, file.id, "a.ts", 2);
      expect(s.area.read(s.projectId, file.id)).toMatchObject({
        language: "typescript",
        html: null,
      });
    } finally {
      s.db.close();
    }
  });

  test("the cache answers the same view for a key and drops the oldest", () => {
    const cache = new RenderCache(2, 100);
    let renders = 0;
    const view = (html: string) => () => {
      renders++;
      return { language: null, html, code: null };
    };
    const a = cache.view("a", view("aa"));
    expect(cache.view("a", view("other"))).toBe(a);
    expect(renders).toBe(1);
    cache.view("b", view("bb"));
    cache.view("a", view("aa"));
    cache.view("c", view("cc"));
    expect(renders).toBe(3);
    // b was the least recently read
    cache.view("b", view("bb"));
    expect(renders).toBe(4);
    expect(cache.view("a", view("aa"))).not.toBe(a);
  });

  test("the cache holds views by their size", () => {
    const cache = new RenderCache(10, 10);
    const view = (html: string) => () => ({ language: null, html, code: null });
    const big = cache.view("big", view("x".repeat(11)));
    expect(cache.view("big", view("x".repeat(11)))).not.toBe(big);
    const one = cache.view("one", view("x".repeat(6)));
    cache.view("two", view("x".repeat(6)));
    expect(cache.view("one", view("x".repeat(6)))).not.toBe(one);
  });
});
