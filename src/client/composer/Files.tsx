// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Everything added to the draft as one panel: a line that says where
// the files stand, a spinner while any of them uploads, and the X that
// removes them all, the upload in flight included. The line opens the
// panel in place: what is attached, each with its own X, and the log of
// what was skipped. The words are Attach.words.ts.

import { useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useMemo } from "preact/hooks";
import { me } from "../data/me.ts";
import {
  askedOf,
  deleteUpload,
  forgetUpload,
  loadUploads,
  staged,
  stagedOf,
  stageUpload,
  takeStamp,
} from "../data/uploads.ts";
import { Icon } from "../lib/icons.tsx";
import {
  RowsLog,
  RowsLogGroup,
  RowsLogLine,
  RowsLogMore,
} from "../ui/Rows.tsx";
import { type AttachItem, AttachState } from "./Attach.state.ts";
import {
  attachedLines,
  LOG_FOLD,
  skippedLines,
  summaryOf,
} from "./Attach.words.ts";
import { readDraft, writeDraftUploads } from "./draft.ts";

// the draft's files for a scope, shown for the project a send goes to
export function useFiles(key: string, projectId: string): AttachState {
  const files = useMemo(
    () =>
      new AttachState(
        {
          stage: stageUpload,
          remove: deleteUpload,
          forget: (_projectId, attempt) => forgetUpload(attempt),
          reload: loadUploads,
          list: stagedOf,
          stamp: takeStamp,
          asked: askedOf,
          wait: (ms) => new Promise((done) => setTimeout(done, ms)),
          currentUser: () => me.value?.id ?? null,
          mint: () => crypto.randomUUID(),
          save: (uploads) => writeDraftUploads(key, uploads),
        },
        readDraft(key).uploads,
      ),
    [key],
  );
  useEffect(() => () => files.dispose(), [files]);
  // before the paint, so Send is never drawn on for a draft whose files
  // are not yet known to the state
  useLayoutEffect(() => files.show(projectId), [files, projectId]);
  const held = staged.value.get(projectId) ?? null;
  useEffect(() => files.reconcile(held), [files, held]);
  return files;
}

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
