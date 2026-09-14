// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chat's menu, opened by the title: the title with a chevron is
// the button, and the card hangs under it. Download saves the chat as
// Markdown; Delete, offered to whoever the server lets delete, asks
// once in place, inside the menu: Delete again does it, Keep closes
// the question. A running chat cannot go, so
// Delete waits for the end. A press outside or Escape closes the
// menu, and Escape gives the focus back to the title. The heading is
// the title button alone, so the items are no part of the page's
// title. The state is Menu.model.ts.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { reason } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { CLOSED, type MenuAction, menuStep } from "./Menu.model.ts";

export function Menu({
  title,
  running,
  download,
  onDelete,
}: {
  title: string;
  // a reply streams or a send is on its way: nothing goes
  running: boolean;
  // the Markdown file's address
  download: string;
  // absent where the chat cannot be deleted from here
  onDelete?: () => Promise<void>;
}) {
  const state = useSignal(CLOSED);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const step = (action: MenuAction) => {
    state.value = menuStep(state.value, action);
  };
  const open = state.value.open;
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
      step({ failed: reason(err) });
    }
  };
  const { asking, busy, failure } = state.value;
  return (
    <div class="chat-menu" ref={root}>
      <h1 class="chat-menu-heading">
        <button
          ref={trigger}
          type="button"
          class="chat-menu-button"
          aria-expanded={open}
          onClick={() => step("toggle")}
        >
          <span class="chat-menu-title">{title}</span>
          <Icon
            name="chevron"
            size={14}
            class={`chat-menu-chevron${open ? " chat-menu-chevron-open" : ""}`}
          />
        </button>
      </h1>
      {open && (
        <div class="chat-menu-card">
          {asking ? (
            <div class="chat-menu-ask">
              <p class={`chat-menu-ask-text${failure ? " error" : ""}`}>
                {failure ?? "Delete this chat?"}
              </p>
              <div class="chat-menu-ask-row">
                <button
                  type="button"
                  class="btn btn-small btn-danger"
                  disabled={busy || running}
                  title={running ? "Stop the chat first" : undefined}
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
              <a
                class="chat-menu-item"
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
                  class="chat-menu-item"
                  disabled={running}
                  title={running ? "Stop the chat first" : undefined}
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
