// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import { noticeOf, type Save } from "../lib/save.ts";
import "./foot.css";
import { CodeTag } from "./CodeTag.tsx";

// every label is laid out in the same cell, so the button keeps the
// width of the widest one whatever it says
export function Foot({
  save,
  dirty,
  label,
  start,
  before,
  above,
  stack,
  inline,
  children,
}: {
  save: Pick<Save, "status" | "busy" | "notice">;
  dirty?: boolean;
  label?: string;
  children?: ComponentChildren;
  start?: ComponentChildren;
  before?: ComponentChildren;
  // its class, which takes the whole line, is the owner's
  above?: ComponentChildren;
  // on a phone the start takes its own line: a hint too long to share
  // one with the buttons
  stack?: boolean;
  // the notice in the start's place, so the buttons never move
  inline?: boolean;
}) {
  const status = save.status.value;
  const done = status === "done";
  const busy = status === "busy";
  const notice = save.notice();
  const on = (yes: boolean) => `foot-label${yes ? " foot-label-on" : ""}`;
  const submit = children ?? (
    <button
      type="submit"
      class={`btn btn-primary foot-submit${done ? " foot-done" : ""}`}
      disabled={save.busy || done || !dirty}
    >
      <span class="foot-labels">
        <span class={on(!busy && !done)}>{label}</span>
        <span class={on(busy)}>Saving</span>
        <span class={on(done)}>
          <Icon name="check" size={14} />
          Saved
        </span>
      </span>
    </button>
  );
  return (
    <div class={`foot${stack ? " foot-stack" : ""}`}>
      {above}
      {notice !== null && !inline && (
        <p class="notice-failed foot-notice" role="alert">
          <Icon name="alert" size={14} class="foot-notice-icon" />
          <span class="foot-notice-words">
            {noticeOf(notice)}
            <CodeTag status={notice.status} class="foot-notice-code" />
          </span>
        </p>
      )}
      {notice !== null && inline ? (
        <div class="foot-start foot-start-beside">
          <span class="error foot-inline" role="alert">
            {noticeOf(notice)}
            <CodeTag status={notice.status} class="foot-notice-code" />
          </span>
        </div>
      ) : (
        start && (
          <div class={`foot-start${inline ? " foot-start-beside" : ""}`}>
            {start}
          </div>
        )
      )}
      {inline ? (
        <div class="foot-actions">
          {before}
          {submit}
        </div>
      ) : (
        <>
          {before}
          {submit}
        </>
      )}
    </div>
  );
}

export function AskDelete({
  save,
  asking,
  busy,
  words,
  wordsClass,
  label = "Delete",
  onAsk,
  onDelete,
}: {
  save: Pick<Save, "pending" | "touch">;
  asking: Signal<boolean>;
  busy: boolean;
  words?: string;
  wordsClass?: string;
  label?: string;
  // it never throws
  onAsk?: () => Promise<void>;
  onDelete: () => void;
}) {
  useEffect(() => {
    if (!asking.value) return;
    // on window: an open picker stops its Escape on the document first
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") asking.value = false;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asking.value]);
  if (!asking.value) {
    return (
      <button
        type="button"
        class="btn"
        disabled={busy}
        onClick={async () => {
          await onAsk?.();
          asking.value = true;
        }}
      >
        Delete
      </button>
    );
  }
  return (
    <>
      {words !== undefined && <span class={wordsClass}>{words}</span>}
      <button
        type="button"
        class="btn btn-danger"
        disabled={busy}
        onClick={onDelete}
      >
        {save.pending.value === "delete" ? "Deleting" : label}
      </button>
      <button
        type="button"
        class="btn"
        disabled={busy}
        onClick={() => {
          asking.value = false;
          save.touch();
        }}
      >
        Keep
      </button>
    </>
  );
}
