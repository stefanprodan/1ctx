// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A file a bash command opened onto the page, Markdown rendered or code
// highlighted by its numbered lines (ui/Source.tsx). The head carries the path and Copy, which takes the
// source; the body is cut to its first lines, Show all in its fade
// (ui/Fold.tsx), and stays whole once open.

import { useEffect } from "preact/hooks";
import { loadOpened, openedFiles } from "../data/session-values.ts";
import { showAll } from "../lib/format.ts";
import { useCut } from "../lib/resize.ts";
import { Fold } from "../ui/Fold.tsx";
import { Source } from "../ui/Source.tsx";
import { CopyButton } from "./Copy.tsx";
import type { FileCard as Card } from "./visuals.ts";
import "./filecard.css";

// the lines the cut shows, the same count in filecard.css
const FOLD_LINES = 12;

export function FileCard({ card }: { card: Card }) {
  const stored = openedFiles.value.get(card.key);
  const { el, open, long } = useCut<HTMLDivElement>([stored]);
  useEffect(() => {
    if (stored === undefined) void loadOpened(card.messageId, card.index);
  }, [stored, card.messageId, card.index]);
  const code = card.file.kind !== "markdown";
  const done = stored?.status === "done" ? stored : null;
  // code draws a line per source line, so its count says a cut hides
  // something before anything is measured; Markdown's blank lines
  // collapse, so only the measure knows
  const cut = long.value || (code && card.file.lines > FOLD_LINES);
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
        <Fold
          cut={cut && !open.value}
          onOpen={() => {
            open.value = true;
          }}
          label={showAll(card.file.lines)}
          framed={code}
          ground={code ? "inset" : "page"}
        >
          <div
            ref={el}
            class={`filecard-body${code ? " filecard-body-code" : ""}${
              open.value ? "" : " filecard-clip"
            }`}
          >
            {code ? (
              // the server highlights or escapes the text; Source cuts it
              // into the lines the text counts
              <Source text={stored.text} html={stored.html} />
            ) : (
              // the server renders the markdown with raw HTML off:
              // render/ is the safety boundary
              <div
                class="filecard-md"
                dangerouslySetInnerHTML={{ __html: stored.html }}
              />
            )}
          </div>
        </Fold>
      )}
    </div>
  );
}
