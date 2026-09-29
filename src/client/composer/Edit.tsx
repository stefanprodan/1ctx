// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A chat's composer over a waiting message: it takes the text a row
// hands it, saves an edit over the row instead of sending, and lets the
// edit go when the chat changes or the row leaves the queue, keeping the
// text as the draft. A save the row no longer takes (a 409) does the
// same, with words that say so.

import { type Signal, useSignal } from "@preact/signals";
import type { RefObject } from "preact";
import { useEffect } from "preact/hooks";
import type { QueuedMessage } from "../../shared/contracts/session.ts";
import { ApiError } from "../data/api.ts";
import { says } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { touch } from "../lib/touch.ts";
import { readDraft, writeDraftText } from "./draft.ts";
import {
  EDIT_GONE,
  EDIT_LOST,
  EDITING,
  type Editing,
  editing,
  handoff,
  takeHandoff,
} from "./handoff.ts";

// the edit open in this chat's composer, or null
export const editOf = (chat: string | null): Editing | null =>
  chat !== null && editing.value?.sessionId === chat ? editing.value : null;

// answers whether a save is on its way
export function useHandoff(
  chat: string | null,
  draftKey: string,
  text: Signal<string>,
  failure: Signal<string | null>,
  input: RefObject<HTMLTextAreaElement>,
  queued: readonly QueuedMessage[] | undefined,
): Signal<boolean> {
  const saving = useSignal(false);
  const next = handoff.value;
  useEffect(() => {
    if (chat === null || next === null || next.sessionId !== chat) return;
    handoff.value = null;
    const taken = takeHandoff(next, text.value, editing.value);
    text.value = taken.text;
    writeDraftText(draftKey, taken.text);
    failure.value = null;
    editing.value = taken.editing;
    if (!touch()) input.current?.focus();
  }, [chat, next, draftKey, text, failure, input]);
  // leaving the chat lets the edit go; its text stays the draft
  useEffect(
    () => () => {
      if (chat !== null && editing.value?.sessionId === chat) {
        editing.value = null;
      }
    },
    [chat],
  );
  const open = editOf(chat);
  const gone =
    open !== null &&
    queued !== undefined &&
    !queued.some((row) => row.id === open.id && row.state === "queued");
  useEffect(() => {
    if (!gone) return;
    editing.value = null;
    failure.value = EDIT_GONE;
  }, [gone, failure]);
  return saving;
}

// Save over the row: the composer empties as after a send; a row that
// started or changed first ends the edit and keeps the text
export async function saveEdit(
  open: Editing,
  content: string,
  onEdit: (row: Editing, text: string) => Promise<void>,
  state: {
    key: string;
    text: Signal<string>;
    failure: Signal<string | null>;
    saving: Signal<boolean>;
  },
): Promise<void> {
  if (content === "" || state.saving.value) return;
  state.saving.value = true;
  state.failure.value = null;
  const sent = state.text.value;
  try {
    await onEdit(open, content);
    if (editing.value?.id === open.id) editing.value = null;
    if (state.text.value === sent) state.text.value = "";
    if (readDraft(state.key).text === sent) {
      writeDraftText(state.key, "");
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      if (editing.value?.id === open.id) editing.value = null;
      state.failure.value = EDIT_LOST;
    } else state.failure.value = says(err);
  } finally {
    state.saving.value = false;
  }
}

// Stop while the reply runs, then Send, or Save while an edit is open
export function SendButtons({
  save,
  off,
  onSend,
  onStop,
  failure,
}: {
  save: boolean;
  off: boolean;
  onSend: () => void;
  onStop?: () => Promise<void>;
  // where a refused Stop says why
  failure: Signal<string | null>;
}) {
  const label = save ? "Save" : "Send";
  return (
    <>
      {onStop !== undefined && (
        <button
          type="button"
          class="composer-send composer-stop"
          aria-label="Stop"
          title="Stop"
          onClick={() => {
            onStop().catch((err) => {
              failure.value = says(err);
            });
          }}
        >
          <Icon name="stop" size={16} />
        </button>
      )}
      <button
        type="button"
        class="composer-send"
        aria-label={label}
        title={label}
        disabled={off}
        onClick={onSend}
      >
        <Icon name={save ? "check" : "send"} size={16} />
      </button>
    </>
  );
}

// the line over the box while an edit is open; Cancel gives the draft
// back as it was before the edit
export function EditLine({
  open,
  draftKey,
  text,
}: {
  open: Editing;
  draftKey: string;
  text: Signal<string>;
}) {
  return (
    <p class="composer-editing">
      <span class="cut">{EDITING}</span>
      <button
        type="button"
        class="btn-text"
        onClick={() => {
          editing.value = null;
          text.value = open.before;
          writeDraftText(draftKey, open.before);
        }}
      >
        Cancel
      </button>
    </p>
  );
}
