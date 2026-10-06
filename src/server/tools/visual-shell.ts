// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import idiomorph from "idiomorph/dist/idiomorph.min.js" with { type: "text" };
import { measureVisual } from "./visual-height.ts";
import {
  cleanVisual,
  inertVisual,
  visualAttributeRule,
  visualElementRule,
  visualScript,
} from "./visual-inert.ts";
import { bootVisual, visualConnect, visualMessage } from "./visual-painter.ts";
import {
  visualContrast,
  visualGround,
  visualSchemeQuery,
} from "./visual-scheme.ts";
import {
  VISUAL_BACKDROPS,
  VISUAL_THEME_CSS,
  visualThemeValues,
} from "./visual-theme.ts";

export function visualCsp(hosts: string[]): string {
  const sources = hosts.length ? ` ${hosts.join(" ")}` : "";
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval'${sources}`,
    `style-src 'unsafe-inline'${sources}`,
    `font-src data:${sources}`,
    "img-src data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

export type VisualScheme = "light" | "dark";

// the frame opens in the chat's scheme, named in its URL: a document whose
// scheme differs from its iframe's paints an opaque canvas until the
// theme message lands, white on a dark chat
export function visualScheme(request?: Request): VisualScheme {
  if (!request) return "light";
  return new URL(request.url).searchParams.get("scheme") === "dark"
    ? "dark"
    : "light";
}

export function visualDocument(scheme: VisualScheme = "light"): string {
  const helpers = {
    clean: cleanVisual,
    inert: inertVisual,
    element: visualElementRule,
    attribute: visualAttributeRule,
    script: visualScript,
    connect: visualConnect,
    message: visualMessage,
    theme: visualThemeValues,
    measure: measureVisual,
    query: visualSchemeQuery,
    contrast: visualContrast,
    ground: visualGround,
  };
  const source = [
    ...Object.entries(helpers).map(([name, fn]) => `${name}: ${fn.toString()}`),
    // data, not a function, so it travels as a literal
    `backdrops: ${JSON.stringify(VISUAL_BACKDROPS)}`,
  ].join(",\n");
  const script = `${idiomorph}\n;(${bootVisual.toString()})({${source}}, Idiomorph);`;
  return `<!doctype html>
<html data-theme="${scheme}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Visual</title>
<style>${VISUAL_THEME_CSS}</style>
</head><body><div id="visual-root"></div>
<script>${script.replace(/<\/script/gi, "<\\/script")}</script>
</body></html>`;
}

const documents: Record<VisualScheme, string> = {
  light: visualDocument("light"),
  dark: visualDocument("dark"),
};

export function visualShell(hosts: string[], request?: Request): Response {
  const csp = visualCsp(hosts);
  const document = documents[visualScheme(request)];
  const etag = `"${new Bun.CryptoHasher("sha256")
    .update(document)
    .update(csp)
    .digest("hex")}"`;
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-cache",
    etag,
  };
  const matches = request?.headers
    .get("if-none-match")
    ?.split(",")
    .some(
      (value) =>
        value.trim().replace(/^W\//, "") === etag || value.trim() === "*",
    );
  return new Response(matches ? null : document, {
    status: matches ? 304 : 200,
    headers,
  });
}
