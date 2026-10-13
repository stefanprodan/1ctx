// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A new team project's labels on the admin's create form: the defaults
// filled in, each row editable and removable, at least one kept. Each
// input is named as the server names its refusal (labels.2.name).

import {
  MAX_LABEL_DESCRIPTION,
  MAX_LABELS_PER_PROJECT,
} from "../../../shared/contracts/label.ts";
import type { Save } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { RowsAdd, RowsRemove } from "../../ui/Rows.tsx";
import { CAP_LINE, type NewLabel } from "./Labels.model.ts";
import "./labels.css";

export function LabelDrafts({
  drafts,
  save,
  class: owner,
  onChange,
}: {
  drafts: readonly NewLabel[];
  save: Save;
  class?: string;
  onChange: (drafts: NewLabel[]) => void;
}) {
  const busy = save.busy;
  const set = (key: number, patch: Partial<NewLabel>) => {
    onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));
    save.touch();
  };
  const full = drafts.length >= MAX_LABELS_PER_PROJECT;
  return (
    <div class={`field${owner ? ` ${owner}` : ""}`}>
      <span class="label label-required">Labels</span>
      {drafts.map((d, i) => {
        const name = `labels.${i}.name`;
        const description = `labels.${i}.description`;
        return (
          <div key={d.key} class="labels-draft-row">
            <div class="labels-draft">
              <input
                name={name}
                class="labels-draft-name"
                aria-label="Label name"
                aria-required="true"
                aria-invalid={save.fieldError(name) !== null || undefined}
                autocomplete="off"
                spellcheck={false}
                placeholder="Name"
                disabled={busy}
                value={d.name}
                onInput={(e) =>
                  set(d.key, {
                    name: (e.currentTarget as HTMLInputElement).value,
                  })
                }
              />
              <input
                name={description}
                class="labels-draft-description"
                aria-label="Label description"
                aria-invalid={
                  save.fieldError(description) !== null || undefined
                }
                autocomplete="off"
                maxLength={MAX_LABEL_DESCRIPTION}
                placeholder="Description"
                disabled={busy}
                value={d.description}
                onInput={(e) =>
                  set(d.key, {
                    description: (e.currentTarget as HTMLInputElement).value,
                  })
                }
              />
              <RowsRemove
                name={d.name.trim() === "" ? "label" : d.name.trim()}
                disabled={busy || drafts.length === 1}
                onRemove={() => {
                  onChange(drafts.filter((other) => other.key !== d.key));
                  save.touch();
                }}
              />
            </div>
            <FieldError save={save} field={name} />
            <FieldError save={save} field={description} />
          </div>
        );
      })}
      {full ? (
        <span class="hint">{CAP_LINE}</span>
      ) : (
        <div class="labels-head">
          <RowsAdd
            label="Add label"
            disabled={busy}
            onClick={() => {
              const key = Math.max(-1, ...drafts.map((d) => d.key)) + 1;
              onChange([...drafts, { key, name: "", description: "" }]);
            }}
          />
        </div>
      )}
    </div>
  );
}
