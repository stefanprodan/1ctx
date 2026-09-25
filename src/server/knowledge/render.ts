// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A file as its page draws it, rendered at read and never stored, so a
// renderer change reaches every file and version at once. A kept view is
// keyed by what cannot change under it: a file's revision or a version.

import type { KnowledgeRendered } from "../../shared/contracts/knowledge.ts";
import { highlight, renderMarkdown } from "../render/index.ts";
import { isMarkdown, languageOf } from "./languages.ts";

// past it the page shows the source: rendered HTML runs to several times
// the text, and a file cap may be raised to megabytes
export const MAX_RENDER_BYTES = 512 * 1024;
export const RENDER_CACHE_ENTRIES = 32;
export const RENDER_CACHE_CHARS = 8 * 1024 * 1024;

export function rendered(
  name: string,
  text: string,
  deleted = false,
): KnowledgeRendered {
  const language = languageOf(name);
  // a delete's version has no text to draw
  if (deleted) return { language, html: null, code: null };
  return {
    language,
    html:
      isMarkdown(name) && Buffer.byteLength(text) <= MAX_RENDER_BYTES
        ? renderMarkdown(text)
        : null,
    code: language === null ? null : highlight(text, language),
  };
}

// least recently read first out, bounded by entries and by characters
export class RenderCache {
  private readonly views = new Map<
    string,
    { view: KnowledgeRendered; size: number }
  >();
  private size = 0;

  constructor(
    private readonly entries = RENDER_CACHE_ENTRIES,
    private readonly chars = RENDER_CACHE_CHARS,
  ) {}

  view(key: string, render: () => KnowledgeRendered): KnowledgeRendered {
    const held = this.views.get(key);
    if (held !== undefined) {
      this.views.delete(key);
      this.views.set(key, held);
      return held.view;
    }
    const view = render();
    const size = (view.html?.length ?? 0) + (view.code?.length ?? 0);
    if (size > this.chars) return view;
    this.views.set(key, { view, size });
    this.size += size;
    for (const [oldest, entry] of this.views) {
      if (this.views.size <= this.entries && this.size <= this.chars) break;
      this.views.delete(oldest);
      this.size -= entry.size;
    }
    return view;
  }
}
