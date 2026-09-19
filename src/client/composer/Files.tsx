// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Everything added to the draft as one panel: a line that says where
// the files stand, a spinner while any of them uploads, and the X that
// removes them all, the upload in flight included. The line opens the
// panel in place: what is attached, each with its own X, and the log of
// what was skipped. The words are Attach.words.ts.

import { useSignal } from "@preact/signals";
import { Icon } from "../lib/icons.tsx";
import {
  RowsLog,
  RowsLogGroup,
  RowsLogLine,
  RowsLogMore,
} from "../ui/Rows.tsx";
import type { AttachItem } from "./Attach.state.ts";
import {
  attachedLines,
  LOG_FOLD,
  skippedLines,
  summaryOf,
} from "./Attach.words.ts";

export function Files({
  items,
  onRemove,
  onClear,
}: {
  items: AttachItem[];
  onRemove: (key: number) => void;
  onClear: () => void;
}) {
  const open = useSignal(false);
  const all = useSignal(false);
  if (items.length === 0) return null;
  const summary = summaryOf(items);
  const attached = attachedLines(items);
  const skipped = skippedLines(items);
  const shown = all.value ? skipped : skipped.slice(0, LOG_FOLD);
  const clear = summary.busy ? "Cancel and remove all" : "Remove all";
  return (
    <div class={`composer-files${open.value ? " composer-files-on" : ""}`}>
      <div class="composer-files-head">
        <button
          type="button"
          class="composer-files-open"
          aria-expanded={open.value}
          onClick={() => {
            open.value = !open.value;
            all.value = false;
          }}
        >
          {summary.busy ? (
            <Icon name="spinner" size={14} class="composer-files-spin" />
          ) : (
            <Icon name="clip" size={14} class="composer-files-icon" />
          )}
          <span class="composer-files-main">{summary.main}</span>
          {summary.more !== "" && (
            <span class="composer-files-more cut">{summary.more}</span>
          )}
          <Icon name="chevron" size={12} class="composer-files-chevron" />
        </button>
        <button
          type="button"
          class="btn-icon composer-files-x"
          aria-label={clear}
          title={clear}
          onClick={onClear}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
      {open.value && (
        <RowsLog bare ends>
          {attached.length > 0 && <RowsLogGroup>Attached</RowsLogGroup>}
          {attached.map((line) => (
            <RowsLogLine
              key={line.key}
              name={line.name}
              note={line.note}
              running={line.running}
              onRemove={() => onRemove(line.key)}
            />
          ))}
          {skipped.length > 0 && <RowsLogGroup>Skipped</RowsLogGroup>}
          {shown.map((line, index) => (
            <RowsLogLine
              // a log line has no id, and the log never reorders
              key={index}
              name={line.name}
              note={line.note}
              status={line.status}
            />
          ))}
          {!all.value && skipped.length > LOG_FOLD && (
            <RowsLogMore
              onClick={() => {
                all.value = true;
              }}
            >
              Show all {skipped.length}
            </RowsLogMore>
          )}
        </RowsLog>
      )}
    </div>
  );
}
