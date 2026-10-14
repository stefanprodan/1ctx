// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Markdown is rendered on the server so the client receives safe HTML and
// ships no parser. Model output is untrusted, making this the safety boundary.

import { isKnowledgeName, MAX_KNOWLEDGE_NAME } from "../../shared/words.ts";
import { ID_SHAPE } from "../lib/ids.ts";
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
// the app's own pages an agent links to: an automation, its memory, a run, a
// chat and an external task, with nothing after the id. A fixed list, since the
// route table is the client's; any other relative path stays text
const APP_HREF = new RegExp(
  `^/(?:automations/${ID_SHAPE}(?:/memory)?|(?:run|chat|external-tasks)/${ID_SHAPE})$`,
);
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

// Bun passes the text of inline code, fenced blocks and link labels
// through text too, and splits a run at a "_" or "*", so text marks its
// runs with tags no escaped text can hold; code and links drop the marks
// and the paths are matched once the neighbouring runs are joined
const MARK_OPEN = "<kp>";
const MARK_CLOSE = "</kp>";
const MARKS = /<\/?kp>/g;
const MARKED_RUN = /<kp>([^<]*)<\/kp>/g;
const unmark = (content: string) => content.replace(MARKS, "");
// a plain path in prose: at a run's start, after white space, or after
// a "(" that is itself at one, over the name's characters
const PROSE_PATH = /(^|\s)(\(?)\/knowledge\/([A-Za-z0-9._/-]+)/g;
// what may follow a path's run: a letter, digit or "%" would mean the
// run was cut out of a longer word, which is never linked
const PATH_FOLLOWER = /[\p{L}\p{N}\p{M}%]/u;
const LINK_PATH = /^\/knowledge\/(.+)$/;
// a run longer than any name is never one, and is not looked into
const MAX_PATH_RUN = MAX_KNOWLEDGE_NAME + 16;
// a run's start is a boundary only where its block or a white space
// starts it, through any opening emphasis; after a closing tag it is
// the tail of a word, such as a web address with an emphasis inside
const OPENING_EMPHASIS = /(?:<(?:strong|em|del) class="[\w-]+">)+$/;
const BLOCK_EDGE =
  /(?:\s|<(?:p|li|td|th|h[1-6]|blockquote) class="[\w -]+"(?: style="[\w:-]+")?>)$/;
// the look back is bounded, so a long reply costs no more per run
const LOOK_BACK = 256;

function startsBlock(html: string, at: number): boolean {
  const from = Math.max(0, at - LOOK_BACK);
  // the marks are still in the html, so a run that ends in white space
  // before the emphasis ends in its close mark
  const opened = html.slice(from, at).replace(OPENING_EMPHASIS, "");
  const before = opened.endsWith(MARK_CLOSE)
    ? opened.slice(0, -MARK_CLOSE.length)
    : opened;
  return (from === 0 && before === "") || BLOCK_EDGE.test(before);
}

const pathHref = (project: string, name: string) =>
  `/projects/${encodeURIComponent(project)}/knowledge/path?name=${encodeURIComponent(name)}`;

// no target, so the client's router takes the click in place
const pathAnchor = (
  project: string,
  name: string,
  label: string,
  title?: string,
) =>
  `<a class="md-link md-path" href="${escapeHtml(pathHref(project, name))}"${
    title ? ` title="${escapeHtml(title)}"` : ""
  }>${label}</a>`;

// atBlock is asked only of a path at the run's start, since its look
// back costs more than the run
function linkPaths(
  run: string,
  project: string,
  atBlock: () => boolean,
): string {
  return run.replace(
    PROSE_PATH,
    (whole, space: string, paren: string, raw: string, at: number) => {
      if (space === "" && !atBlock()) return whole;
      if (raw.length > MAX_PATH_RUN) return whole;
      const after = run[at + whole.length];
      if (after !== undefined && PATH_FOLLOWER.test(after)) return whole;
      // a trailing "." ends the sentence, not the name
      let end = raw.length;
      while (end > 0 && raw[end - 1] === ".") end--;
      const name = raw.slice(0, end);
      if (!isKnowledgeName(name)) return whole;
      const path = `/knowledge/${name}`;
      return `${space}${paren}${pathAnchor(project, name, path)}${raw.slice(end)}`;
    },
  );
}

const TABLE_ALIGNMENTS = new Set(["left", "center", "right"]);

export const tableAlign = (value: string | undefined) =>
  value !== undefined && TABLE_ALIGNMENTS.has(value)
    ? ` style="text-align:${value}"`
    : "";

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
    const title = meta.title ? ` title="${escapeHtml(meta.title)}"` : "";
    // no new tab, so the client's router takes the click in place
    if (APP_HREF.test(meta.href)) {
      return `<a class="md-link" href="${escapeHtml(meta.href)}"${title}>${content}</a>`;
    }
    if (!SAFE_HREF.test(meta.href)) return content;
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

// the callbacks that link knowledge paths to the project's file pages
function pathCallbacks(project: string) {
  return {
    ...CALLBACKS,
    text: (content: string) =>
      `${MARK_OPEN}${escapeHtml(content)}${MARK_CLOSE}`,
    codespan: (content: string) => CALLBACKS.codespan(unmark(content)),
    code: (content: string, meta?: { language?: string }) =>
      CALLBACKS.code(unmark(content), meta),
    link: (content: string, meta: { href: string; title?: string }) => {
      const label = unmark(content);
      const name = LINK_PATH.exec(meta.href)?.[1];
      if (name === undefined || !isKnowledgeName(name)) {
        return CALLBACKS.link(label, meta);
      }
      return pathAnchor(project, name, label, meta.title);
    },
    image: (content: string, meta: { src: string }) =>
      CALLBACKS.image(unmark(content), meta),
  };
}

const LINKED = { ...OPTIONS, autolinks: { url: true } } as const;

type RenderOptions = { autolinks?: boolean; project?: string };

// Parser failures keep the reply readable. autolinks links bare http(s)
// URLs, for text people paste links into, such as an external task's entries.
// project links /knowledge/ paths to that project's files; without it
// they stay text.
export function renderMarkdown(
  md: string,
  options: RenderOptions = {},
): string {
  if (md === "") return "";
  const parse = options.autolinks ? LINKED : OPTIONS;
  try {
    const project = options.project;
    // most replies name no path and pay nothing for the pass
    if (project === undefined || !md.includes("/knowledge/")) {
      return Bun.markdown.render(md, CALLBACKS, parse);
    }
    return Bun.markdown
      .render(md, pathCallbacks(project), parse)
      .replaceAll(`${MARK_CLOSE}${MARK_OPEN}`, "")
      .replace(MARKED_RUN, (_, run: string, at: number, html: string) =>
        run.includes("/knowledge/")
          ? linkPaths(run, project, () => startsBlock(html, at))
          : run,
      );
  } catch {
    return `<p class="md-p">${escapeHtml(md)}</p>`;
  }
}
