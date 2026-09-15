// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one memory card both pages draw: the count against the limit and
// who wrote the note last, the entries as plain lines or as the diff
// with the previous version, then Undo and Edit for everyone in the
// project. Edit is a list of boxes saved through useSave(); a note that
// moved meanwhile is the form's notice with Reload.

import { useSignal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Memory } from "../../../shared/contracts/memory.ts";
import { diffEntries } from "../../../shared/memory.ts";
import { loadMemory, saveMemory, undoMemory } from "../../data/memory.ts";
import type { Failure } from "../../lib/format.ts";
import { userHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { noticeOf, useSave } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import { Rows, RowsCard } from "../../ui/Rows.tsx";
import { countLine, draftDirty, draftEntries, writerOf } from "./Note.model.ts";
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
  const draft = useSignal<string[]>(
    memory.entries.length === 0 ? [""] : [...memory.entries],
  );
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {
    await saveMemory(memoryKey, {
      entries: draftEntries(draft.value),
      revision: memory.revision,
    });
    onDone();
  });
  const set = (index: number, text: string) => {
    draft.value = draft.value.map((e, i) => (i === index ? text : e));
    save.touch();
  };
  const entries = draftEntries(draft.value);
  const count = countLine(entries);
  const notice = save.notice();
  return (
    <form
      class="note-form"
      ref={form}
      onSubmit={(event) => {
        event.preventDefault();
        void save.run(null);
      }}
    >
      {draft.value.map((text, index) => (
        <div class="note-box" key={index}>
          <textarea
            class="input"
            aria-label={`Entry ${index + 1}`}
            rows={2}
            value={text}
            disabled={save.busy}
            onInput={(e) =>
              set(index, (e.currentTarget as HTMLTextAreaElement).value)
            }
          />
          <button
            type="button"
            class="btn btn-small"
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
            draft.value = [...draft.value, ""];
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
  const shown =
    view === "changes" && memory.previous !== null
      ? diffEntries(memory.previous, memory.entries)
      : memory.entries.map((text) => ({ text, kind: "kept" as const }));
  return (
    <Rows>
      <RowsCard
        label={label}
        hint={countLine(memory.entries)}
        action={
          !editing.value && (
            <span class="note-switch">
              <button
                type="button"
                class={`note-switch-tab${view === "current" ? " note-switch-on" : ""}`}
                onClick={() => setView("current")}
              >
                Current
              </button>
              <button
                type="button"
                class={`note-switch-tab${view === "changes" ? " note-switch-on" : ""}`}
                disabled={memory.previous === null}
                onClick={() => setView("changes")}
              >
                Changes
              </button>
            </span>
          )
        }
      >
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
                    {entry.text}
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
