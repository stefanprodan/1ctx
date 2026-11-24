// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The link page loads no stylesheet, so its look is copied: every value
// it names must be the one tokens.css gives that name, in each theme,
// and its lockup the client's.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { livePage } from "../../../src/server/web/link-page.ts";

const CLIENT = join(import.meta.dir, "../../../src/client");
const tokens = readFileSync(join(CLIENT, "style/tokens.css"), "utf8");

// the custom properties of a block, by name
function declared(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
    out.set(m[1]!, m[2]!.trim().replace(/\s+/g, " "));
  }
  return out;
}

// the block that follows a selector, to its closing brace
function block(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`no ${selector}`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

const html = await livePage("A".repeat(43)).text();
const style = /<style>([\s\S]*)<\/style>/.exec(html)![1]!;

test("its values are tokens.css's, in the dark and the light theme", () => {
  const dark = declared(block(tokens, ":root {"));
  const light = declared(block(tokens, ':root[data-theme="light"] {'));
  const pageDark = declared(block(style, ":root{"));
  const pageLight = declared(
    block(style.slice(style.indexOf("@media")), ":root{"),
  );
  expect(pageDark.size).toBeGreaterThan(10);
  for (const [name, value] of pageDark) expect(value).toBe(dark.get(name)!);
  expect(pageLight.size).toBeGreaterThan(5);
  for (const [name, value] of pageLight) expect(value).toBe(light.get(name)!);
  // the light theme sets every colour the dark one does
  for (const name of pageDark.keys()) {
    if (/^#/.test(pageDark.get(name)!)) expect(pageLight.has(name)).toBe(true);
  }
  // nothing past the two blocks names a colour, a font or a radius
  const rules = style.slice(style.indexOf("}}") + 2);
  expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|font-family|radius:\d/i);
  expect(rules).not.toMatch(/font-size:\d|font:\d/);
});

test("its lockup is the client's mark and wordmark", () => {
  const icons = readFileSync(join(CLIENT, "lib/icons.tsx"), "utf8");
  const paths = [...html.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]!);
  expect(paths).toHaveLength(4);
  for (const d of paths) expect(icons).toContain(d);
});
