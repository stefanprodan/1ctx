// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { type FieldOf, type Save, useSave } from "../../lib/save.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { holding, useLatest } from "./drafts.ts";

export type DraftCard<D> = {
  d: D;
  save: Save;
  set: (patch: Partial<D>) => void;
  foot: (o?: {
    hint?: ComponentChildren;
    blocked?: boolean;
  }) => ComponentChildren;
};

export function useDraftCard<R, D extends object>({
  row,
  saving,
  of,
  dirty,
  send,
  fieldOf,
}: {
  row: R;
  // one card saves at a time, so a slower answer never puts back what a
  // later save changed
  saving: Signal<boolean>;
  of: (row: R) => D;
  dirty: (d: D, row: R) => boolean;
  send: (d: D, row: R) => Promise<unknown>;
  fieldOf?: FieldOf;
}): DraftCard<D> {
  const drafted = useSignal<Partial<D> | null>(null);
  // the save is built once: it reads the row of the moment, so another
  // card's save in between is not undone
  const latest = useLatest({ row, send });
  const merged = (r: R): D => ({ ...of(r), ...(drafted.value ?? {}) });
  const save = useSave(async () => {
    const { row: r, send: call } = latest.current;
    await holding(saving, () => call(merged(r), r));
    drafted.value = null;
  }, fieldOf);
  const d = merged(row);
  const changed = dirty(d, row);
  return {
    d,
    save,
    set: (patch) => {
      drafted.value = { ...(drafted.value ?? {}), ...patch };
      save.touch();
    },
    foot: (o) => (
      <DraftFoot
        save={save}
        dirty={changed}
        blocked={o?.blocked}
        locked={saving.value && !save.busy}
        hint={o?.hint}
        onDiscard={() => {
          drafted.value = null;
        }}
      />
    ),
  };
}
