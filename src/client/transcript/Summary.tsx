// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The summary round's fold under an answer that filled the window,
// or the whole of a compact turn. Drawn like the work fold: shut by
// default, a clock in the label while the summary streams, the tokens
// folded once it is done, and the summary inside as rendered Markdown
// with the streaming tail after it. Whether it is open is kept per row
// for the life of the page.

import type { Message } from "../../shared/contracts/session.ts";
import { Icon } from "../lib/icons.tsx";
import { folds, useTick } from "./fold.ts";
import { summaryLabel, summaryRunning } from "./Summary.model.ts";
import type { Live } from "./stream.ts";
import { tail } from "./stream.ts";

const { useFoldOpen } = folds();

export function Summary({
  message,
  live,
}: {
  message: Message;
  live: ReadonlyMap<string, Live>;
}) {
  const running = summaryRunning(message, live);
  const current = running ? (live.get(message.id) ?? null) : null;
  useTick(running);
  const label = summaryLabel(message, running, Date.now());
  const { open, onToggle } = useFoldOpen(message.id);
  const html = current?.html ?? message.html;
  return (
    <details
      class={`transcript-fold transcript-summary${
        running ? " transcript-fold-live" : ""
      }${open ? " transcript-fold-open" : ""}`}
      open={open}
      onToggle={onToggle}
    >
      <summary class="transcript-fold-head">
        <Icon name="spinner" size={13} class="transcript-fold-spin" />
        <Icon name="chevron-right" size={13} class="transcript-fold-chevron" />
        <span class={label.err ? "transcript-summary-err" : ""}>
          {label.text}
        </span>
      </summary>
      <div class="transcript-summary-body">
        {html !== "" && (
          // the server renders the markdown with raw HTML off: render/
          // is the safety boundary
          <div
            class="transcript-md"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {current !== null && <div class="transcript-tail">{tail(current)}</div>}
        {!running && html === "" && message.content !== "" && (
          <div class="transcript-work-plain">{message.content}</div>
        )}
      </div>
    </details>
  );
}
