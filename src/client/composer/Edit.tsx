// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A chat's composer over a waiting message. It takes what a row hands
// it (handoff.ts), keeps an open edit in the draft so a reload keeps
// editing, saves the edit over the row instead of sending, and gives
// the set-aside draft back after Save or Cancel. An edit the row no
// longer takes (a 409, or the row gone from the queue while no save is
// on its way) ends with its text kept and the draft after it, with
// words that say so; the files and switches of the draft wait for the
// next message, since an edit changes the text alone.

import { type Signal, useSignal } from "@preact/signals";
import type { RefObject } from "preact";
import { useEffect } from "preact/hooks";
import type { AgentSummary } from "../../shared/contracts/agent.ts";
import type { QueuedMessage } from "../../shared/contracts/session.ts";
import { ApiError } from "../data/api.ts";
import { says } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { touch } from "../lib/touch.ts";
import { readDraft, writeDraftEdit } from "./draft.ts";
import {
  EDIT_GONE,
  EDIT_LOST,
  EDIT_OPEN,
  EDITING,
  type Editing,
  editing,
  type Handoff,
  handoff,
  merged,
  takeHandoff,
} from "./handoff.ts";

export const PLACEHOLDER_RUNNING = "Write a message for after the reply";

// the edit open in this chat's composer, or null
export const editOf = (chat: string | null): Editing | null =>
  chat !== null && editing.value?.sessionId === chat ? editing.value : null;

// the box at rest: no agent yet, a reply running, or the view's words
export function placeholderOf(
  agents: AgentSummary[] | null,
  running: boolean,
  idle: string,
): string {
  if (agents !== null && agents.length === 0) {
    return "No agent yet: an admin adds one first";
  }
  return running ? PLACEHOLDER_RUNNING : idle;
}

type Box = {
  key: string;
  text: Signal<string>;
  failure: Signal<string | null>;
};

// the edit let go: the box keeps its text with the set-aside draft
// after it, as a draft of its own, and says why
function endEdit(box: Box, open: Editing, words: string): void {
  if (editing.value?.id === open.id) editing.value = null;
  const text = merged(box.text.value, open.before);
  box.text.value = text;
  writeDraftEdit(box.key, text, undefined);
  box.failure.value = words;
}

// an open edit whose row left the queue, read when the effect runs: a
// save on its way answers for itself, and a Remove here closes the edit
// with its own words
export function editGone(
  open: Editing,
  queued: readonly QueuedMessage[] | undefined,
  saving: boolean,
  pending: Handoff | null,
): boolean {
  if (queued === undefined || saving) return false;
  if (pending?.kind === "close" && pending.id === open.id) return false;
  return !queued.some((row) => row.id === open.id && row.state === "queued");
}

// the composer's side of an edit; answers the signal a save holds
// while it is on its way
export function useHandoff(
  chat: string | null,
  box: Box,
  input: RefObject<HTMLTextAreaElement>,
  queued: readonly QueuedMessage[] | undefined,
): Signal<boolean> {
  const saving = useSignal(false);
  const { key, text, failure } = box;
  // the draft's edit is the chat's, after a navigation or a reload too
  useEffect(() => {
    if (chat === null) return;
    const edit = readDraft(key).edit;
    editing.value = edit === undefined ? null : { ...edit, sessionId: chat };
    // leaving lets the mirror go; the draft keeps the edit
    return () => {
      if (editing.value?.sessionId === chat) editing.value = null;
    };
  }, [chat, key]);
  const next = handoff.value;
  useEffect(() => {
    if (chat === null || next === null || next.sessionId !== chat) return;
    handoff.value = null;
    const taken = takeHandoff(next, text.value, editOf(chat));
    if (taken === null) {
      if (next.kind !== "close") failure.value = EDIT_OPEN;
      return;
    }
    text.value = taken.text;
    writeDraftEdit(key, taken.text, taken.edit);
    editing.value =
      taken.edit === undefined ? null : { ...taken.edit, sessionId: chat };
    failure.value = taken.words;
    if (!touch()) input.current?.focus();
  }, [chat, next, key, text, failure, input]);
  useEffect(() => {
    const now = chat === null ? null : editOf(chat);
    if (now !== null && editGone(now, queued, saving.value, handoff.value)) {
      endEdit(box, now, EDIT_GONE);
    }
  });
  return saving;
}

// Save over the row: the set-aside draft comes back as after a send
export async function saveEdit(
  open: Editing,
  content: string,
  onEdit: ((row: Editing, text: string) => Promise<void>) | undefined,
  box: Box & { saving: Signal<boolean> },
): Promise<void> {
  if (onEdit === undefined || content === "" || box.saving.value) return;
  box.saving.value = true;
  box.failure.value = null;
  const sent = box.text.value;
  try {
    await onEdit(open, content);
    if (editing.value?.id === open.id) editing.value = null;
    // what was typed while the save was on its way stays, before the
    // draft that comes back
    const text =
      box.text.value === sent
        ? open.before
        : merged(box.text.value, open.before);
    box.text.value = text;
    writeDraftEdit(box.key, text, undefined);
    box.failure.value = null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      endEdit(box, open, EDIT_LOST);
    } else box.failure.value = says(err);
  } finally {
    box.saving.value = false;
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
export function EditLine({ open, box }: { open: Editing; box: Box }) {
  return (
    <p class="composer-editing">
      <span class="cut">{EDITING}</span>
      <button
        type="button"
        class="btn-text"
        onClick={() => {
          editing.value = null;
          box.text.value = open.before;
          box.failure.value = null;
          writeDraftEdit(box.key, open.before, undefined);
        }}
      >
        Cancel
      </button>
    </p>
  );
}
