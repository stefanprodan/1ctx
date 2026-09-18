// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chat's menu, opened by the title: the title with a chevron is
// the button, and the card hangs under it. Rename, on a chat, turns
// the title into a box in the same place and the same type, so the
// head keeps its height: Enter saves, Escape or leaving the box gives
// the title back, and a refusal hangs under the box until the next
// key. Download saves the chat as Markdown; Delete, offered to whoever
// the server lets delete, asks once in place, inside the menu: Delete
// again does it, Keep closes the question. A running chat cannot go,
// so Delete waits for the end; Rename never does. A press outside or Escape
// closes the menu, and Escape gives the focus back to the title. The
// heading is the title button alone, so the items are no part of the
// page's title. The state is Menu.model.ts.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { says } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { CLOSED, type MenuAction, menuStep } from "./Menu.model.ts";

export function Menu({
  title,
  noun = "chat",
  running,
  download,
  onDelete,
  onRename,
}: {
  title: string;
  noun?: "chat" | "run";
  // a reply streams or a send is on its way: nothing goes
  running: boolean;
  // the Markdown file's address
  download: string;
  // absent where the chat cannot be deleted from here
  onDelete?: () => Promise<void>;
  // absent where the title cannot be changed from here: a run's is its
  // automation's
  onRename?: (title: string) => Promise<void>;
}) {
  const state = useSignal(CLOSED);
  const draft = useSignal("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const step = (action: MenuAction) => {
    state.value = menuStep(state.value, action);
  };
  const open = state.value.open;
  const editing = state.value.editing;
  // the title button is mounted again only after the box goes, so the
  // focus it gets back is given on the render after
  const refocus = useRef(false);
  useEffect(() => {
    if (editing) {
      box.current?.focus();
      box.current?.select();
    } else if (refocus.current) {
      refocus.current = false;
      trigger.current?.focus();
    }
  }, [editing]);
  const edit = () => {
    draft.value = title;
    step("edit");
  };
  const save = async () => {
    if (onRename === undefined || state.value.busy) return;
    const next = draft.value.trim();
    if (next === "" || next === title) {
      step("dismiss");
      return;
    }
    step("start");
    try {
      await onRename(next);
      refocus.current = true;
      step("saved");
    } catch (err) {
      step({ failed: says(err) });
    }
  };
  useEffect(() => {
    if (!open) return;
    // on pointerdown, while the pressed item is still in the tree: a
    // click lands after the item gave way to the question
    const onPress = (ev: PointerEvent) => {
      if (!root.current?.contains(ev.target as Node)) step("dismiss");
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      // a focused item is about to leave the tree; the focus would
      // fall to the page and a keyboard user would lose their place
      const within = root.current?.contains(document.activeElement) ?? false;
      step("dismiss");
      if (within && !state.value.open) trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPress);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPress);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, state]);
  const remove = async () => {
    if (onDelete === undefined) return;
    step("start");
    try {
      await onDelete();
    } catch (err) {
      step({ failed: says(err) });
    }
  };
  const { asking, busy, failure } = state.value;
  return (
    <div class="chat-menu" ref={root}>
      <h1 class="chat-menu-heading">
        {editing ? (
          <input
            ref={box}
            class="chat-menu-input"
            aria-label="Title"
            aria-invalid={failure ? true : undefined}
            // read-only, not disabled, while the save is on its way: a
            // disabled box loses the focus, and with it Escape and blur
            readOnly={busy}
            value={draft.value}
            onInput={(ev) => {
              draft.value = ev.currentTarget.value;
              if (failure) step({ failed: "" });
            }}
            onKeyDown={(ev) => {
              // Enter that picks an IME candidate is not a submit
              if (ev.isComposing) return;
              if (ev.key === "Enter") {
                ev.preventDefault();
                void save();
              } else if (ev.key === "Escape") {
                ev.preventDefault();
                refocus.current = true;
                step("dismiss");
              }
            }}
            onBlur={() => {
              if (!state.value.busy) step("dismiss");
            }}
          />
        ) : (
          <button
            ref={trigger}
            type="button"
            class="chat-menu-button"
            aria-expanded={open}
            onClick={() => step("toggle")}
          >
            <span class="cut">{title}</span>
            <Icon
              name="chevron"
              size={14}
              class={`chat-menu-chevron${open ? " chat-menu-chevron-open" : ""}`}
            />
          </button>
        )}
      </h1>
      {editing && failure && (
        <div class="menu chat-menu-card chat-menu-failure error">{failure}</div>
      )}
      {open && (
        <div class="menu chat-menu-card">
          {asking ? (
            <div class="chat-menu-ask">
              <p class={`chat-menu-ask-text${failure ? " error" : ""}`}>
                {failure ?? `Delete this ${noun}?`}
              </p>
              <div class="chat-menu-ask-row">
                <button
                  type="button"
                  class="btn btn-small btn-danger"
                  disabled={busy || running}
                  title={running ? `Stop the ${noun} first` : undefined}
                  onClick={() => void remove()}
                >
                  {busy ? "Deleting" : "Delete"}
                </button>
                <button
                  type="button"
                  class="btn btn-small"
                  disabled={busy}
                  onClick={() => step("keep")}
                >
                  Keep
                </button>
              </div>
            </div>
          ) : (
            <>
              {onRename !== undefined && (
                <button type="button" class="menu-item" onClick={edit}>
                  <Icon name="pencil" size={14} />
                  <span>Rename</span>
                </button>
              )}
              <a
                class="menu-item"
                href={download}
                download
                onClick={() => step("dismiss")}
              >
                <Icon name="download" size={14} />
                <span>Download</span>
              </a>
              {onDelete !== undefined && (
                <button
                  type="button"
                  class="menu-item"
                  disabled={running}
                  title={running ? `Stop the ${noun} first` : undefined}
                  onClick={() => step("ask")}
                >
                  <Icon name="trash" size={14} />
                  <span>Delete</span>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
