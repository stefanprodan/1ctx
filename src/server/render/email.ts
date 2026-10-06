// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent's Markdown as an email's HTML and plain text. The text is
// untrusted and the reader trusts the email more than a chat, so a
// link is written as its full address, never the label the agent gave
// it; an image is dropped, since loading it would tell its host the
// email was read; raw HTML never renders: a block is dropped and a span
// stays escaped text. Nothing carries a class, a script or an image.
// A bidi control could show a text or an address reversed: the body
// loses them, and a link shows the address its parse writes back.

import { stripBidi } from "../../shared/words.ts";
import { escapeHtml, tableAlign } from "./markdown.ts";

// raw HTML blocks reach the html callback, which drops them; spans stay
// text, escaped like any other. A bare URL stays text: Bun's autolinks
// break the markup around a URL that ends inside emphasis, and mail
// clients link a bare URL themselves
const OPTIONS = { noHtmlSpans: true } as const;

// the address a link shows and opens: an http(s) URL with no user
// info, as the URL parser writes it back, which percent-encodes what
// could reorder or hide part of it; null shows the href as text
function linkable(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.href;
}

// a table cell's end in the plain text, split again by its row
const CELL = "␟";

type ListMeta = { ordered: boolean; start?: number; depth?: number };
type ItemMeta = ListMeta & { index?: number; checked?: boolean };

const HTML = {
  text: (content: string) => escapeHtml(content),
  // a paragraph of an image alone is left empty
  paragraph: (content: string) =>
    content.trim() === "" ? "" : `<p>${content}</p>`,
  heading: (content: string, meta: { level: number }) =>
    `<h${meta.level}>${content}</h${meta.level}>`,
  blockquote: (content: string) => `<blockquote>${content}</blockquote>`,
  hr: () => "<hr>",
  strong: (content: string) => `<strong>${content}</strong>`,
  emphasis: (content: string) => `<em>${content}</em>`,
  strikethrough: (content: string) => `<del>${content}</del>`,
  codespan: (content: string) => `<code>${content}</code>`,
  // the text callback escaped the code already
  code: (content: string) => `<pre><code>${content}</code></pre>`,
  link: (_content: string, meta: { href: string }) => {
    const url = linkable(meta.href);
    if (url === null) return escapeHtml(meta.href);
    const href = escapeHtml(url);
    return `<a href="${href}">${href}</a>`;
  },
  image: () => "",
  html: () => "",
  list: (content: string, meta: ListMeta) =>
    meta.ordered
      ? `<ol${
          meta.start !== undefined && meta.start !== 1
            ? ` start="${meta.start}"`
            : ""
        }>${content}</ol>`
      : `<ul>${content}</ul>`,
  listItem: (content: string, meta: ItemMeta) =>
    `<li>${
      meta.checked === undefined ? "" : meta.checked ? "[x] " : "[ ] "
    }${content}</li>`,
  table: (content: string) => `<table>${content}</table>`,
  thead: (content: string) => `<thead>${content}</thead>`,
  tbody: (content: string) => `<tbody>${content}</tbody>`,
  tr: (content: string) => `<tr>${content}</tr>`,
  th: (content: string, meta?: { align?: string }) =>
    `<th${tableAlign(meta?.align)}>${content}</th>`,
  td: (content: string, meta?: { align?: string }) =>
    `<td${tableAlign(meta?.align)}>${content}</td>`,
};

const block = (content: string) => `${content.trim()}\n\n`;

const TEXT = {
  text: (content: string) => content,
  paragraph: block,
  heading: block,
  blockquote: (content: string) =>
    block(
      content
        .trim()
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n"),
    ),
  hr: () => "---\n\n",
  strong: (content: string) => content,
  emphasis: (content: string) => content,
  strikethrough: (content: string) => content,
  codespan: (content: string) => content,
  code: (content: string) => `${content.replace(/\n$/, "")}\n\n`,
  link: (_content: string, meta: { href: string }) =>
    linkable(meta.href) ?? meta.href,
  image: () => "",
  html: () => "",
  // a nested list hangs under its item's line
  list: (content: string, meta: ListMeta) =>
    (meta.depth ?? 0) === 0 ? `${content}\n` : `\n${content.trimEnd()}`,
  listItem: (content: string, meta: ItemMeta) => {
    const mark = meta.ordered
      ? `${(meta.start ?? 1) + (meta.index ?? 0)}.`
      : "-";
    const box =
      meta.checked === undefined ? "" : meta.checked ? "[x] " : "[ ] ";
    return `${"  ".repeat(meta.depth ?? 0)}${mark} ${box}${content.trim()}\n`;
  },
  table: (content: string) => `${content}\n`,
  thead: (content: string) => content,
  tbody: (content: string) => content,
  tr: (content: string) => `${content.split(CELL).slice(0, -1).join(" | ")}\n`,
  th: (content: string) => `${content}${CELL}`,
  td: (content: string) => `${content}${CELL}`,
};

export type EmailBody = { html: string; text: string };

// a parser failure leaves the text as it was, escaped; the bidi
// controls go from what is rendered, so an entity that wrote one goes
// too
export function renderEmailMarkdown(md: string): EmailBody {
  if (md.trim() === "") return { html: "", text: "" };
  try {
    return {
      html: stripBidi(Bun.markdown.render(md, HTML, OPTIONS)),
      text: stripBidi(Bun.markdown.render(md, TEXT, OPTIONS))
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    };
  } catch {
    const text = stripBidi(md);
    return { html: `<p>${escapeHtml(text)}</p>`, text: text.trim() };
  }
}
