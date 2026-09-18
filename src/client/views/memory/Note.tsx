// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one memory card both pages draw: the count against the limit and
// who wrote the note last, the entries as plain lines or as the diff
// with the previous version, then Undo and Edit for everyone in the
// project. Edit is a Topic field over a Text box per entry, saved
// through useSave(); a refusal naming an entry shows at its field, and a
// note that moved meanwhile is the form's notice with Reload.

import { useSignal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Memory, MemoryEntry } from "../../../shared/contracts/memory.ts";
import {
  type DiffEntry,
  diffEntries,
  MEMORY_ENTRY_CHARS,
} from "../../../shared/memory.ts";
import { loadMemory, saveMemory, undoMemory } from "../../data/memory.ts";
import type { Failure } from "../../lib/format.ts";
import { userHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { noticeOf, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { Rows, RowsCard } from "../../ui/Rows.tsx";
import {
  countLine,
  draftDirty,
  draftEntries,
  draftProblem,
  noteFieldOf,
  textField,
  textSize,
  topicField,
  writerOf,
} from "./Note.model.ts";
import "./note.css";

function Writer({ memory, now }: { memory: Memory; now: number }) {
  const writer = writerOf(memory, now);
  if (writer.kind === "none") return null;
  if (writer.kind === "user") {
    return (
      <span>
        Written {writer.when} by{" "}
        <a class="note-head-link" href={userHref(writer.username)}>
          @{writer.username}
        </a>
      </span>
    );
  }
  return (
    <span>
      Written {writer.when} by{" "}
      <a class="note-head-link" href={`/chat/${writer.sessionId}`}>
        a run
      </a>{" "}
      of{" "}
      {writer.automationId === null ? (
        "a deleted automation"
      ) : (
        <a class="note-head-link" href={`/automations/${writer.automationId}`}>
          {writer.automationName}
        </a>
      )}
    </span>
  );
}

function Editor({
  memory,
  memoryKey,
  onDone,
}: {
  memory: Memory;
  memoryKey: string;
  onDone: () => void;
}) {
  const draft = useSignal<MemoryEntry[]>(
    memory.entries.length === 0
      ? [{ topic: "", text: "" }]
      : memory.entries.map((entry) => ({ ...entry })),
  );
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(
    async () => {
      await saveMemory(memoryKey, {
        entries: draftEntries(draft.value),
        revision: memory.revision,
      });
      onDone();
    },
    (message) => noteFieldOf(message, draft.value),
  );
  useFocusField(save, form);
  const set = (index: number, patch: Partial<MemoryEntry>) => {
    draft.value = draft.value.map((e, i) =>
      i === index ? { ...e, ...patch } : e,
    );
    save.touch();
  };
  const entries = draftEntries(draft.value);
  const count = countLine(entries);
  const notice = save.notice();
  const invalid = (field: string) => save.fieldError(field) !== null;
  return (
    <form
      class="note-form"
      ref={form}
      onSubmit={(event) => {
        event.preventDefault();
        void save.run(draftProblem(draft.value));
      }}
    >
      {draft.value.map((entry, index) => (
        <div class="note-box" key={index}>
          <div class="note-box-fields">
            <label class="field">
              <span class="label">Topic</span>
              <input
                name={topicField(index)}
                autocomplete="off"
                aria-invalid={invalid(topicField(index)) || undefined}
                disabled={save.busy}
                value={entry.topic}
                onInput={(e) =>
                  set(index, {
                    topic: (e.currentTarget as HTMLInputElement).value,
                  })
                }
              />
              <FieldError save={save} field={topicField(index)} />
            </label>
            <label class="field">
              <span class="label">Text</span>
              <textarea
                name={textField(index)}
                rows={3}
                aria-invalid={invalid(textField(index)) || undefined}
                disabled={save.busy}
                value={entry.text}
                onInput={(e) =>
                  set(index, {
                    text: (e.currentTarget as HTMLTextAreaElement).value,
                  })
                }
              />
              {invalid(textField(index)) ? (
                <FieldError save={save} field={textField(index)} />
              ) : (
                <span
                  class={`hint note-box-size${entry.text.trim().length > MEMORY_ENTRY_CHARS ? " error" : ""}`}
                >
                  {textSize(entry.text)}
                </span>
              )}
            </label>
          </div>
          <button
            type="button"
            class="btn btn-small note-box-remove"
            aria-label={`Remove entry ${index + 1}`}
            disabled={save.busy}
            onClick={() => {
              draft.value = draft.value.filter((_, i) => i !== index);
              save.touch();
            }}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      <div class="note-form-foot">
        <button
          type="button"
          class="btn btn-small"
          disabled={save.busy}
          onClick={() => {
            draft.value = [...draft.value, { topic: "", text: "" }];
            save.touch();
          }}
        >
          <Icon name="plus" size={12} />
          Add
        </button>
        <span class="note-form-count">{count}</span>
      </div>
      <Foot
        save={save}
        dirty={draftDirty(draft.value, memory.entries)}
        label="Save"
        start={
          notice !== null && notice.status === 409 ? (
            <button
              type="button"
              class="btn"
              onClick={() => {
                void loadMemory(memoryKey).then(onDone);
              }}
            >
              Reload
            </button>
          ) : (
            <span />
          )
        }
        before={
          <button type="button" class="btn" onClick={onDone}>
            Cancel
          </button>
        }
      />
    </form>
  );
}

export function Note({
  memory,
  memoryKey,
  error,
  empty,
}: {
  memory: Memory | null;
  memoryKey: string;
  error: Failure | null;
  // the words for a note with no entries
  empty: string;
}) {
  const [view, setView] = useState<"current" | "changes">("current");
  const editing = useSignal(false);
  const now = Date.now();
  const undo = useSave(async () => {});
  useEffect(() => {
    editing.value = false;
  }, [memoryKey]);
  const notice = undo.notice();
  const label = "Memory";
  if (memory === null) {
    return (
      <Rows>
        <RowsCard label={label}>
          <p class="note-empty">
            {error === null ? "Loading" : `Did not load. ${error.words}`}
          </p>
        </RowsCard>
      </Rows>
    );
  }
  const shown: DiffEntry[] =
    view === "changes" && memory.previous !== null
      ? diffEntries(memory.previous, memory.entries)
      : memory.entries.map((entry) => ({ ...entry, kind: "kept" }));
  return (
    <Rows>
      <RowsCard
        label={label}
        hint={countLine(memory.entries)}
        action={
          !editing.value && (
            <span class="seg seg-small note-switch">
              <button
                type="button"
                class={`seg-option${view === "current" ? " seg-on" : ""}`}
                onClick={() => setView("current")}
              >
                Current
              </button>
              <button
                type="button"
                class={`seg-option${view === "changes" ? " seg-on" : ""}`}
                disabled={memory.previous === null}
                onClick={() => setView("changes")}
              >
                Changes
              </button>
            </span>
          )
        }
      >
        {error !== null && (
          <p class="note-notice note-notice-line" role="alert">
            Could not refresh. {error.words}
          </p>
        )}
        {memory.updatedAt !== null && (
          <div class="note-head">
            <Writer memory={memory} now={now} />
            {view === "changes" && <span>since the previous version</span>}
          </div>
        )}
        {editing.value ? (
          <Editor
            memory={memory}
            memoryKey={memoryKey}
            onDone={() => {
              editing.value = false;
            }}
          />
        ) : (
          <>
            {shown.length === 0 ? (
              <p class="note-empty">{empty}</p>
            ) : (
              <ul class="note-entries">
                {shown.map((entry, index) => (
                  <li key={index} class={`note-entry note-entry-${entry.kind}`}>
                    <span class="note-entry-topic">{entry.topic}</span>
                    {entry.kind === "changed" && (
                      <span class="note-entry-old">{entry.oldText}</span>
                    )}
                    <span class="note-entry-text">{entry.text}</span>
                  </li>
                ))}
              </ul>
            )}
            <div class="note-actions">
              <button
                type="button"
                class="btn btn-small"
                disabled={undo.busy}
                onClick={() => {
                  editing.value = true;
                  undo.touch();
                }}
              >
                <Icon name="pencil" size={12} />
                Edit
              </button>
              <button
                type="button"
                class="btn btn-small"
                disabled={undo.busy || memory.previous === null}
                onClick={() => {
                  void undo.act("undo", () =>
                    undoMemory(memoryKey, { revision: memory.revision }),
                  );
                }}
              >
                <Icon name="redo" size={12} />
                {undo.pending.value === "undo" ? "Undoing" : "Undo"}
              </button>
              {notice !== null && (
                <span class="note-notice" role="alert">
                  {noticeOf(notice)}
                </span>
              )}
            </div>
          </>
        )}
      </RowsCard>
    </Rows>
  );
}
