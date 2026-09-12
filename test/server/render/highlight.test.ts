// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Curated server-side syntax highlighting behavior.

import { describe, expect, test } from "bun:test";
import { highlight, MAX_BYTES } from "../../../src/server/render/index.ts";

describe("highlight", () => {
  test("highlights a known language", () => {
    const html = highlight("const value = 1;", "typescript");
    expect(html).not.toBeNull();
    expect(html).toContain('<span class="hljs-keyword">const</span>');
  });

  test("resolves model-written aliases", () => {
    const python = highlight("print('ok')", "python3");
    const terminal = highlight("echo ok", "terminal");
    expect(python).not.toBeNull();
    expect(python).toContain('<span class="hljs-built_in">print</span>');
    expect(terminal).not.toBeNull();
  });

  test("returns null for an unknown language", () => {
    expect(highlight("value", "unknown")).toBeNull();
  });

  test("returns null for a block over the size limit", () => {
    expect(
      highlight("é".repeat(Math.floor(MAX_BYTES / 2) + 1), "typescript"),
    ).toBeNull();
  });

  test("escapes angle brackets in code", () => {
    const html = highlight("if (a < b) return <tag>;", "typescript");
    expect(html).not.toBeNull();
    expect(html).toContain("&lt;");
    expect(html).not.toContain("<tag>");
  });
});
