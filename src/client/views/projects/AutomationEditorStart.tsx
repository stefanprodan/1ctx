// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The start of the automation editor's foot: Delete, which asks in
// place with Keep, Delete and Delete with runs, or Reload once a save
// came after someone else's.

import type { Signal } from "@preact/signals";
import type { Save } from "../../lib/save.ts";

export function EditorStart({
  save,
  asking,
  stale,
  onReload,
  onRemove,
}: {
  save: Pick<Save, "busy" | "pending" | "touch">;
  asking: Signal<boolean>;
  // the last save was refused as stale
  stale: boolean;
  onReload: () => void;
  // true deletes the runs too
  onRemove: (runs: boolean) => void;
}) {
  const busy = save.busy;
  if (stale) {
    return (
      <button type="button" class="btn" disabled={busy} onClick={onReload}>
        Reload
      </button>
    );
  }
  if (!asking.value) {
    return (
      <button
        type="button"
        class="btn"
        disabled={busy}
        onClick={() => {
          asking.value = true;
        }}
      >
        Delete
      </button>
    );
  }
  return (
    <>
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
      <button
        type="button"
        class="btn btn-danger"
        disabled={busy}
        onClick={() => onRemove(false)}
      >
        {save.pending.value === "delete" ? "Deleting" : "Delete"}
      </button>
      <button
        type="button"
        class="btn btn-danger"
        disabled={busy}
        onClick={() => onRemove(true)}
      >
        {save.pending.value === "purge" ? "Deleting" : "Delete with runs"}
      </button>
    </>
  );
}
