// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A file a bash command opened onto the page, Markdown rendered or code
// highlighted. The head carries the path and Copy, which takes the
// source; the body is cut to its first lines with Show all, never a
// scroll box of its own inside the shell's scroll box.

import { useEffect } from "preact/hooks";
import { loadOpened, openedFiles } from "../data/session-values.ts";
import { useCut } from "../lib/resize.ts";
import { CopyButton } from "./Copy.tsx";
import type { FileCard as Card } from "./visuals.ts";
import "./filecard.css";

// the lines the cut shows, the same count in filecard.css
export const FOLD_LINES = 12;

export function FileCard({ card }: { card: Card }) {
  const stored = openedFiles.value.get(card.key);
  const { el, open, long } = useCut<HTMLDivElement>([stored]);
  useEffect(() => {
    if (stored === undefined) void loadOpened(card.messageId, card.index);
  }, [stored, card.messageId, card.index]);
  const code = card.file.kind !== "markdown";
  const done = stored?.status === "done" ? stored : null;
  // the file's own lines say a cut hides something before anything is
  // measured; the measure catches a rendering taller than its source
  const cut = long.value || card.file.lines > FOLD_LINES;
  return (
    <div class="filecard" data-file={card.key}>
      <div class="filecard-head">
        <span class="filecard-path cut" title={card.file.path}>
          {card.file.path}
        </span>
        {code && card.file.language !== null && (
          <span class="tag">{card.file.language}</span>
        )}
        {done !== null && <CopyButton text={done.text} />}
      </div>
      {stored === undefined || stored.status === "loading" ? (
        <div class="filecard-state">Loading</div>
      ) : stored.status === "failed" ? (
        <div class="filecard-error">{stored.error}</div>
      ) : (
        <>
          <div
            ref={el}
            class={`filecard-body${code ? " filecard-body-code" : ""}${
              open.value ? "" : " filecard-clip"
            }`}
          >
            {code ? (
              // the server highlights or escapes the text; the pre and
              // the code element are the client's
              <pre class="filecard-pre">
                <code
                  class="filecard-code"
                  dangerouslySetInnerHTML={{ __html: stored.html }}
                />
              </pre>
            ) : (
              // the server renders the markdown with raw HTML off:
              // render/ is the safety boundary
              <div
                class="filecard-md"
                dangerouslySetInnerHTML={{ __html: stored.html }}
              />
            )}
          </div>
          {cut && (
            <button
              type="button"
              class="btn-text filecard-more"
              aria-expanded={open.value}
              onClick={() => {
                open.value = !open.value;
              }}
            >
              {open.value ? "Show less" : "Show all"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
