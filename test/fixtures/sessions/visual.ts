// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export const visualTitle = "A small diagram";
export const visualHtml = "<svg><text>résumé 🦊 東京</text></svg>";
export const visualArguments = ` { "title": "${visualTitle}", "html": ${JSON.stringify(visualHtml)} } `;

export const malformedVisualArguments = [
  {
    name: "unfinished JSON",
    arguments: `{"title":"Diagram","html":${JSON.stringify(visualHtml)}`,
    bytes: 0,
  },
  {
    name: "a JSON string",
    arguments: JSON.stringify(visualHtml),
    bytes: 0,
  },
  {
    name: "an array",
    arguments: JSON.stringify([{ title: visualTitle, html: visualHtml }]),
    bytes: 0,
  },
  {
    name: "null",
    arguments: "null",
    bytes: 0,
  },
  {
    name: "a nested fragment",
    arguments: JSON.stringify({
      title: visualTitle,
      html: { html: visualHtml },
    }),
    bytes: 0,
  },
  {
    name: "a nested title",
    arguments: JSON.stringify({ title: { html: visualHtml }, html: visualHtml }),
    bytes: new TextEncoder().encode(visualHtml).length,
  },
  {
    name: "an extra field",
    arguments: JSON.stringify({
      title: visualTitle,
      html: visualHtml,
      duplicate: { html: visualHtml },
    }),
    bytes: new TextEncoder().encode(visualHtml).length,
  },
  {
    name: "an oversized title",
    arguments: JSON.stringify({ title: "x".repeat(100_000), html: visualHtml }),
    bytes: new TextEncoder().encode(visualHtml).length,
  },
  {
    name: "a missing fragment",
    arguments: JSON.stringify({ title: visualTitle }),
    bytes: 0,
  },
  {
    name: "a numeric fragment",
    arguments: JSON.stringify({ title: visualTitle, html: 42 }),
    bytes: 0,
  },
];
