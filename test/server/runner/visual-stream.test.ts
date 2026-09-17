// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { VisualStream } from "../../../src/server/runner/visual-stream.ts";
import { MAX_TITLE } from "../../../src/shared/words.ts";
import {
  duplicateVisualDocuments,
  incompleteVisualDocuments,
  invalidVisualDocuments,
  nonObjectVisualDocuments,
  visualChunks,
  visualDocuments,
} from "../../fixtures/runner/visual-stream.ts";

const bytes = (text: string) => new TextEncoder().encode(text).length;
const reader = () => new VisualStream(256 * 1024);

describe("visual stream", () => {
  test.each(visualChunks)("$name", ({ chunks, html }) => {
    const stream = reader();
    for (const [index, chunk] of chunks.entries()) {
      stream.push(chunk);
      expect(stream.html).toBe(html[index] as string);
      expect(stream.ended).toBe(false);
    }
    expect(stream.complete).toBe(true);
    expect(stream.scanned).toBe(chunks.join("").length);
  });

  test.each(visualDocuments)(
    "matches JSON decoding at every boundary: %s",
    (document) => {
      const expected = JSON.parse(document) as { html: string; title?: string };
      for (let boundary = 0; boundary <= document.length; boundary++) {
        const stream = reader();
        stream.push(document.slice(0, boundary));
        expect(expected.html.startsWith(stream.html)).toBe(true);
        const prefix = stream.html;
        stream.push(document.slice(boundary));
        expect(stream.html.startsWith(prefix)).toBe(true);
        expect(stream.html).toBe(expected.html);
        expect(stream.title).toBe(expected.title);
        expect(stream.complete).toBe(true);
        expect(stream.ended).toBe(false);
        expect(stream.scanned).toBe(document.length);
      }
    },
  );

  test.each(visualDocuments)(
    "every code-unit prefix agrees with JSON decoding: %s",
    (document) => {
      const expected = JSON.parse(document) as { html: string; title?: string };
      const stream = reader();
      for (let index = 0; index < document.length; index++) {
        const before = stream.html;
        stream.push(document[index] as string);
        expect(stream.html.startsWith(before)).toBe(true);
        expect(expected.html.startsWith(stream.html)).toBe(true);
        expect(stream.scanned).toBe(index + 1);
      }
      expect(stream.html).toBe(expected.html);
      expect(stream.title).toBe(expected.title);
      expect(stream.complete).toBe(true);
      expect(stream.ended).toBe(false);
    },
  );

  test("the closing quote stops html while later title text waits", () => {
    const stream = reader();
    stream.push('{"html":"<p>hello</p>"');
    expect(stream.html).toBe("<p>hello</p>");
    expect(stream.title).toBeUndefined();
    expect(stream.complete).toBe(false);
    stream.push(',"title":"the \\"html\\" key');
    expect(stream.title).toBeUndefined();
    expect(stream.html).toBe("<p>hello</p>");
    stream.push('"');
    expect(stream.title).toBe('the "html" key');
    expect(stream.complete).toBe(false);
    stream.push("}");
    expect(stream.complete).toBe(true);
    expect(stream.ended).toBe(false);
  });

  test("a repeated title is published only once the new string closes", () => {
    const stream = reader();
    stream.push('{"title":"First","html":"ok","title":"Sec');
    expect(stream.title).toBe("First");
    stream.push('ond"}');
    expect(stream.title).toBe("Second");
    expect(stream.complete).toBe(true);
  });

  test("oversized titles are discarded, never exposed in part", () => {
    const stream = reader();
    stream.push(`{"title":"${"x".repeat(MAX_TITLE)}`);
    expect(stream.title).toBeUndefined();
    stream.push('x","html":"ok"}');
    expect(stream.title).toBeUndefined();
    expect(stream.html).toBe("ok");
    expect(stream.complete).toBe(true);
    expect(stream.ended).toBe(false);
    const exact = reader();
    const title = "🚀".repeat(MAX_TITLE / 2);
    exact.push(JSON.stringify({ title, html: "ok" }));
    expect(exact.title).toBe(title);
  });

  test.each(duplicateVisualDocuments)(
    "a duplicate freezes the first draft instead of replacing it: %s",
    (document) => {
      const stream = reader();
      const split = document.lastIndexOf(":");
      stream.push(document.slice(0, split));
      expect(stream.html).toBe("first");
      expect(stream.ended).toBe(true);
      expect(stream.complete).toBe(false);
      const scanned = stream.scanned;
      stream.push(document.slice(split));
      stream.push('{"html":"another"}');
      expect(stream.html).toBe("first");
      expect(stream.scanned).toBe(scanned);
      // JSON keeps the last value; an append-only preview cannot undo the first.
      expect((JSON.parse(document) as { html: unknown }).html).not.toBe(
        stream.html,
      );
    },
  );

  test("a duplicate also ends a draft whose first html was not a string", () => {
    const stream = reader();
    stream.push('{"html":{"html":"nested"},"html"');
    expect(stream.html).toBe("");
    expect(stream.ended).toBe(true);
    expect(stream.complete).toBe(false);
  });

  test.each(invalidVisualDocuments)(
    "invalid syntax stops at any chunk boundary: %s",
    (document) => {
      expect(() => JSON.parse(document)).toThrow();
      for (let boundary = 0; boundary <= document.length; boundary++) {
        const stream = reader();
        stream.push(document.slice(0, boundary));
        stream.push(document.slice(boundary));
        expect(stream.ended).toBe(true);
        const { html, title, scanned } = stream;
        stream.push('{"html":"ignored","title":"ignored"}');
        expect(stream.html).toBe(html);
        expect(stream.title).toBe(title);
        expect(stream.scanned).toBe(scanned);
        expect(scanned).toBeLessThanOrEqual(document.length);
      }
    },
  );

  test.each(nonObjectVisualDocuments)(
    "a non-object root ends the reader: %s",
    (document) => {
      for (let boundary = 0; boundary <= document.length; boundary++) {
        const stream = reader();
        stream.push(document.slice(0, boundary));
        stream.push(document.slice(boundary));
        expect(stream.html).toBe("");
        expect(stream.title).toBeUndefined();
        expect(stream.ended).toBe(true);
        expect(stream.complete).toBe(false);
        expect(stream.scanned).toBe(1);
        stream.push('{"html":"ignored"}');
        expect(stream.html).toBe("");
        expect(stream.scanned).toBe(1);
      }
    },
  );

  test.each(incompleteVisualDocuments)(
    "an unfinished token is incomplete, not invalid: %s",
    (document) => {
      const stream = reader();
      stream.push(document);
      expect(stream.ended).toBe(false);
      expect(stream.complete).toBe(false);
      expect(stream.scanned).toBe(document.length);
    },
  );

  test.each(["{}", '{"title":"No fragment"}', '{"html":{"html":"nested"}}'])(
    "completion tracks syntax, not tool argument validation: %s",
    (document) => {
      const stream = reader();
      stream.push(document);
      expect(stream.html).toBe("");
      expect(stream.ended).toBe(false);
      expect(stream.complete).toBe(true);
    },
  );

  test("completion survives whitespace but a second value ends the reader", () => {
    const stream = reader();
    stream.push('{"html":"ok"}');
    expect(stream.complete).toBe(true);
    stream.push(" \r\n\t");
    expect(stream.ended).toBe(false);
    stream.push("{}");
    expect(stream.ended).toBe(true);
    expect(stream.complete).toBe(true);
    expect(stream.html).toBe("ok");
  });

  test.each(["", "a", "é", "東京", "🚀", "\uD83D", "\uDE80", "aé東京🚀"])(
    "the exact UTF-8 cap permits the closing quote and later title: %j",
    (html) => {
      const stream = new VisualStream(bytes(html));
      const document = JSON.stringify({ html, title: "Later" });
      for (let index = 0; index < document.length; index++) {
        stream.push(document[index] as string);
        expect(bytes(stream.html)).toBeLessThanOrEqual(bytes(html));
      }
      expect(stream.html).toBe(html);
      expect(stream.title).toBe("Later");
      expect(stream.ended).toBe(false);
      expect(stream.complete).toBe(true);
    },
  );

  test.each([
    { cap: 0, chunks: ['{"html":"x'], html: "" },
    { cap: 3, chunks: ['{"html":"abc', "d"], html: "abc" },
    { cap: 2, chunks: ['{"html":"é', "a"], html: "é" },
    { cap: 2, chunks: ['{"html":"a', "é"], html: "a" },
    { cap: 3, chunks: ['{"html":"東', "京"], html: "東" },
    { cap: 3, chunks: ['{"html":"\\uD83D', "\\uDE80"], html: "" },
    { cap: 4, chunks: ['{"html":"\\uD83D', "\\uDE80", "a"], html: "🚀" },
    { cap: 3, chunks: ['{"html":"\uD83D', "\uDE80"], html: "" },
    { cap: 2, chunks: ['{"html":"\\uD83D', '"'], html: "" },
    { cap: 3, chunks: ['{"html":"\\uD83D', "x"], html: "\uD83D" },
  ])(
    "the cap stops on a whole decoded character: %j",
    ({ cap, chunks, html }) => {
      const stream = new VisualStream(cap);
      for (const chunk of chunks) {
        stream.push(chunk);
        expect(bytes(stream.html)).toBeLessThanOrEqual(cap);
      }
      expect(stream.html).toBe(html);
      expect(stream.ended).toBe(true);
      expect(stream.complete).toBe(false);
      const scanned = stream.scanned;
      stream.push('ignored","title":"Later"}');
      expect(stream.html).toBe(html);
      expect(stream.title).toBeUndefined();
      expect(stream.scanned).toBe(scanned);
    },
  );

  test("large tiny chunks visit each input code unit exactly once", () => {
    const html = "<p>é東京🚀</p>".repeat(4_000);
    const document =
      `{"${"unknown".repeat(10_000)}":"${"ignored".repeat(10_000)}",` +
      `"title":"${"x".repeat(10_000)}","nested":[[[{"html":"ignored"}]]],` +
      `"html":${JSON.stringify(html)},"number":${"1".repeat(10_000)}}`;
    const stream = new VisualStream(bytes(html));
    for (let index = 0; index < document.length; index++) {
      stream.push(document[index] as string);
    }
    expect(stream.scanned).toBe(document.length);
    expect(stream.html).toBe(html);
    expect(stream.title).toBeUndefined();
    expect(stream.complete).toBe(true);
    expect(stream.ended).toBe(false);
  });

  test("deep ignored values use an explicit stack rather than recursion", () => {
    const stream = reader();
    stream.push(
      `{"other":${"[".repeat(10_000)}0${"]".repeat(10_000)},"html":"ok"}`,
    );
    expect(stream.html).toBe("ok");
    expect(stream.complete).toBe(true);
    expect(stream.ended).toBe(false);
  });
});
