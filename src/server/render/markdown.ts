// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Markdown is rendered on the server so the client receives safe HTML and
// ships no parser. Model output is untrusted, making this the safety boundary.

import { highlight } from "./highlight.ts";

const OPTIONS = { noHtmlBlocks: true, noHtmlSpans: true } as const;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// This reverses escapeHtml in reverse order so text such as "&amp;lt;"
// returns to the entity the model wrote before the grammar escapes it again.
function unescapeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

const SAFE_HREF = /^(https?:|mailto:)/i;
// the same strokes as the client's copy and check icons; the button
// carries both and the client shows the check for a moment after a copy
const ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="';
const COPY_ICON = `${ICON}md-copy-icon"><path class="md-icon-path" d="M6 6h7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM3.5 10.5h-.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5"/></svg>`;
const CHECK_ICON = `${ICON}md-copy-done"><path class="md-icon-path" d="M3 8.5l3 3 7-7"/></svg>`;
const COPY_BLOCK = `<button type="button" class="md-copy" title="Copy" aria-label="Copy block">${COPY_ICON}${CHECK_ICON}</button>`;

// Info strings may contain attributes after the first word, but only a plain
// language token is safe and useful in a data attribute.
function language(info: string | undefined): string {
  const word = (info ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[\w+#.-]{1,24}$/.test(word) ? word.toLowerCase() : "";
}

function codeBlock(text: string, info: string | undefined): string {
  const lang = language(info);
  const body = (lang && highlight(unescapeHtml(text), lang)) || text;
  const pre = `<pre class="md-pre"><code class="md-block-code">${body}</code></pre>`;
  // without a language a head would hold only the copy button, an empty
  // bar over the block, so the button takes a column beside the code
  if (!lang)
    return `<div class="md-block md-block-bare">${pre}${COPY_BLOCK}</div>`;
  return (
    `<div class="md-block" data-lang="${escapeHtml(lang)}">` +
    `<div class="md-block-head"><span class="md-block-lang">${escapeHtml(lang)}</span>${COPY_BLOCK}</div>` +
    `${pre}</div>`
  );
}

const TABLE_ALIGNMENTS = new Map([
  ["left", "left"],
  ["center", "center"],
  ["right", "right"],
]);

export const tableAlign = (value: string | undefined) => {
  const alignment = value ? TABLE_ALIGNMENTS.get(value) : undefined;
  return alignment ? ` style="text-align:${alignment}"` : "";
};

const CALLBACKS = {
  text: (content: string) => escapeHtml(content),
  paragraph: (content: string) => `<p class="md-p">${content}</p>`,
  heading: (content: string, meta: { level: number }) =>
    `<h${meta.level} class="md-h${meta.level}">${content}</h${meta.level}>`,
  blockquote: (content: string) =>
    `<blockquote class="md-quote">${content}</blockquote>`,
  hr: () => '<hr class="md-hr">',
  strong: (content: string) => `<strong class="md-strong">${content}</strong>`,
  emphasis: (content: string) => `<em class="md-em">${content}</em>`,
  strikethrough: (content: string) => `<del class="md-del">${content}</del>`,
  codespan: (content: string) => `<code class="md-code">${content}</code>`,
  code: (content: string, meta?: { language?: string }) =>
    codeBlock(content, meta?.language),
  link: (content: string, meta: { href: string; title?: string }): string => {
    if (!SAFE_HREF.test(meta.href)) return content;
    const title = meta.title ? ` title="${escapeHtml(meta.title)}"` : "";
    return `<a class="md-link" href="${escapeHtml(meta.href)}"${title} target="_blank" rel="noopener">${content}</a>`;
  },
  // Showing the source preserves useful context without causing a browser
  // request chosen by untrusted model output.
  image: (content: string, meta: { src: string }) =>
    `<span class="md-img">[image${content ? `: ${content}` : ""}${
      meta.src ? ` ${escapeHtml(meta.src)}` : ""
    }]</span>`,
  list: (content: string, meta: { ordered: boolean; start?: number }) =>
    meta.ordered
      ? `<ol class="md-ol"${
          meta.start !== undefined && meta.start !== 1
            ? ` start="${meta.start}"`
            : ""
        }>${content}</ol>`
      : `<ul class="md-ul">${content}</ul>`,
  listItem: (content: string, meta: { checked?: boolean }) =>
    meta.checked === undefined
      ? `<li class="md-li">${content}</li>`
      : `<li class="md-li md-task"><input class="md-check" type="checkbox" disabled${
          meta.checked ? " checked" : ""
        }> ${content}</li>`,
  // The wrapper contains wide tables within the rendered reply.
  table: (content: string) =>
    `<div class="md-table-wrap"><table class="md-table">${content}</table></div>`,
  thead: (content: string) => `<thead class="md-thead">${content}</thead>`,
  tbody: (content: string) => `<tbody class="md-tbody">${content}</tbody>`,
  tr: (content: string) => `<tr class="md-tr">${content}</tr>`,
  th: (content: string, meta?: { align?: string }) =>
    `<th class="md-th"${tableAlign(meta?.align)}>${content}</th>`,
  td: (content: string, meta?: { align?: string }) =>
    `<td class="md-td"${tableAlign(meta?.align)}>${content}</td>`,
};

// Parser failures keep the reply readable. Streaming will control diagram
// rendering when diagrams are added.
export function renderMarkdown(md: string, streaming = false): string {
  if (md === "") return "";
  void streaming;
  try {
    return Bun.markdown.render(md, CALLBACKS, OPTIONS);
  } catch {
    return `<p class="md-p">${escapeHtml(md)}</p>`;
  }
}
