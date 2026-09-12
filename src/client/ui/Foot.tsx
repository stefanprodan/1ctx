// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The foot of a form: the submit button that says what a Save is going
// through, the refusal beside it, and room on the left for what else
// the form offers. A view composes this, never restyles it.

import type { ComponentChildren } from "preact";
import { Icon } from "../lib/icons.tsx";
import type { Status } from "../lib/save.ts";
import "./foot.css";

// every label is laid out in the same cell, so the button keeps the
// width of the widest one whatever it says
export function Foot({
  status,
  dirty,
  label,
  start,
  before,
}: {
  status: Status;
  dirty: boolean;
  label: string;
  // what sits at the left end, apart from the submit: a Delete
  start?: ComponentChildren;
  // what sits right before the submit: a Cancel
  before?: ComponentChildren;
}) {
  const done = status === "done";
  const busy = status === "busy";
  const on = (yes: boolean) => `foot-label${yes ? " foot-label-on" : ""}`;
  return (
    <div class="foot">
      {start && <div class="foot-start">{start}</div>}
      {before}
      <button
        type="submit"
        class={`btn btn-primary${done ? " foot-done" : ""}`}
        disabled={busy || done || !dirty}
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
      {typeof status === "object" && (
        <span class="foot-note error">{status.error}</span>
      )}
    </div>
  );
}
