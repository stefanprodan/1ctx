// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a phone reads to install the app: the manifest, the icons it
// names at the paths the server serves, and the page's colours.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLIENT = join(import.meta.dir, "../../src/client");
const SITE = join(import.meta.dir, "../../site");
const MAIN = join(import.meta.dir, "../../src/server/main.ts");
const read = (name: string) => readFileSync(join(CLIENT, name), "utf8");

const manifest = JSON.parse(read("manifest.webmanifest")) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};

// the width and height from a PNG's header chunk
function pngSize(bytes: Buffer): string {
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

function pageColour(block: string): string {
  const tokens = read("style/tokens.css");
  const start = tokens.indexOf(block);
  const found = /--page:\s*(#[0-9a-f]{6});/.exec(tokens.slice(start));
  if (start === -1 || found === null) throw new Error(`no --page in ${block}`);
  return found[1];
}

describe("the manifest", () => {
  test("opens the whole app on its start page, without the browser", () => {
    expect(manifest.name).toBe("1ctx");
    expect(manifest.short_name).toBe("1ctx");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  test("its colours are the dark page", () => {
    const dark = pageColour(":root {");
    expect(manifest.background_color).toBe(dark);
    expect(manifest.theme_color).toBe(dark);
  });

  test("names icons the server serves, at their declared sizes", () => {
    const purposes = manifest.icons.map((i) => `${i.sizes} ${i.purpose}`);
    expect(purposes.sort()).toEqual([
      "192x192 any",
      "512x512 any",
      "512x512 maskable",
    ]);
    // main.ts embeds each file and serves it at the path named
    const main = readFileSync(MAIN, "utf8");
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      expect(pngSize(readFileSync(join(CLIENT, icon.src)))).toBe(icon.sizes);
      expect(main).toContain(`from "../client${icon.src}"`);
      expect(main).toContain(`"${icon.src}": `);
    }
  });
});

describe("the page", () => {
  test("links the manifest and the touch icon, sized for iOS", () => {
    const html = read("index.html");
    expect(html).toContain('rel="manifest" href="./manifest.webmanifest"');
    expect(html).toContain(
      'rel="apple-touch-icon" href="./apple-touch-icon.png"',
    );
    expect(html).toContain("viewport-fit=cover");
    expect(pngSize(readFileSync(join(CLIENT, "apple-touch-icon.png")))).toBe(
      "180x180",
    );
  });

  test("never sends its address to another site", () => {
    expect(read("index.html")).toContain(
      '<meta name="referrer" content="no-referrer" />',
    );
  });

  test("starts the browser's bar in the theme's page colour", () => {
    const html = read("index.html");
    expect(html).toContain(
      `name="theme-color" content="${pageColour(":root {")}"`,
    );
    expect(html).toContain(
      `"content", "${pageColour(':root[data-theme="light"]')}"`,
    );
  });

  test("its icons are the brand's files", () => {
    for (const name of [
      "apple-touch-icon.png",
      "icon-192.png",
      "icon-512.png",
      "icon-maskable-512.png",
      "favicon.svg",
    ]) {
      expect(readFileSync(join(CLIENT, name))).toEqual(
        readFileSync(join(SITE, name)),
      );
    }
  });
});
