// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The foot of a form: the notice of a refusal that names no field, on
// its own line over the buttons so they never move when it shows; the
// submit button that says what a Save is going through; and room on the
// left for the form's other actions. A view composes this, never
// restyles it.

import type { ComponentChildren } from "preact";
import { Icon } from "../lib/icons.tsx";
import { noticeOf, type Save } from "../lib/save.ts";
import "./foot.css";

// every label is laid out in the same cell, so the button keeps the
// width of the widest one whatever it says
export function Foot({
  save,
  dirty,
  label,
  start,
  before,
  after,
  children,
}: {
  save: Pick<Save, "status" | "busy" | "notice">;
  dirty?: boolean;
  label?: string;
  children?: ComponentChildren;
  // what sits at the left end, apart from the submit: a Delete
  start?: ComponentChildren;
  // what sits right before the submit: a Cancel
  before?: ComponentChildren;
  // what follows the submit: a Reset beside it, a count at the end
  after?: ComponentChildren;
}) {
  const status = save.status.value;
  const done = status === "done";
  const busy = status === "busy";
  const notice = save.notice();
  const on = (yes: boolean) => `foot-label${yes ? " foot-label-on" : ""}`;
  return (
    <div class="foot">
      {notice !== null && (
        <p class="notice-failed foot-notice" role="alert">
          <Icon name="alert" size={14} class="foot-notice-icon" />
          <span class="foot-notice-words">
            {noticeOf(notice)}
            {notice.status !== undefined && (
              <span class="code-tag foot-notice-code">
                HTTP {notice.status}
              </span>
            )}
          </span>
        </p>
      )}
      {start && <div class="foot-start">{start}</div>}
      {before}
      {children ?? (
        <button
          type="submit"
          class={`btn btn-primary${done ? " foot-done" : ""}`}
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
      )}
      {after}
    </div>
  );
}
