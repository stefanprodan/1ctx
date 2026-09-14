// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chat's menu, opened by the title: the title with a chevron is
// the button, and the card hangs under it. Delete for now, more to
// follow. Delete asks once in place, inside the menu: Delete again
// does it, Keep closes the question. A running chat cannot go, so
// Delete waits for the end. A press outside or Escape closes the
// menu. The state is Menu.model.ts; everything here is a span, since
// the page head puts it inside its heading.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { reason } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { CLOSED, type MenuAction, menuStep } from "./Menu.model.ts";

export function Menu({
  title,
  running,
  onDelete,
}: {
  title: string;
  // a reply streams or a send is on its way: nothing goes
  running: boolean;
  onDelete: () => Promise<void>;
}) {
  const state = useSignal(CLOSED);
  const root = useRef<HTMLSpanElement>(null);
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
      if (ev.key === "Escape") step("dismiss");
    };
    document.addEventListener("pointerdown", onPress);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPress);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, state]);
  const remove = async () => {
    step("start");
    try {
      await onDelete();
    } catch (err) {
      step({ failed: reason(err) });
    }
  };
  const { asking, busy, failure } = state.value;
  return (
    <span class="chat-menu" ref={root}>
      <button
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
      {open && (
        <span class="chat-menu-card">
          {asking ? (
            <span class="chat-menu-ask">
              <span class={`chat-menu-ask-text${failure ? " error" : ""}`}>
                {failure ?? "Delete this chat?"}
              </span>
              <span class="chat-menu-ask-row">
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
              </span>
            </span>
          ) : (
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
        </span>
      )}
    </span>
  );
}
