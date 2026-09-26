// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One scope's limits as a settings section: the fields side by side,
// each its label with the default beside a changed one, the value with
// its unit inside the box, and the line under it; Save and Reset to
// defaults under them. The form is the Limits tab's, through
// useLimitsForm.

import type { LimitRow } from "../../../shared/contracts/limit.ts";
import type { LimitScope } from "../../../shared/words.ts";
import type { Save } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { Section, SectionForm } from "../../ui/Section.tsx";
import { useLimitsForm } from "./LimitsCard.tsx";
import { defaultLine, dirty, displayOf, LIMIT_WORDS } from "./Tools.model.ts";

function LimitField({
  row,
  text,
  busy,
  save,
  onInput,
}: {
  row: LimitRow;
  text: string;
  busy: boolean;
  // a refusal that names this limit is drawn in place of its hint
  save: Pick<Save, "fieldError">;
  onInput: (text: string) => void;
}) {
  const { word } = displayOf(row);
  const words = LIMIT_WORDS[row.name];
  const error = save.fieldError(row.name);
  return (
    <label class="field">
      <span class="section-label">
        <span class="label">{words.label}</span>
        {row.changedAt !== null && (
          <span class="section-fact">{defaultLine(row)}</span>
        )}
      </span>
      <span class={`section-number${error ? " section-number-invalid" : ""}`}>
        <input
          class="section-number-input"
          name={row.name}
          type="text"
          inputMode="decimal"
          autocomplete="off"
          spellcheck={false}
          disabled={busy}
          value={text}
          aria-invalid={error ? true : undefined}
          onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
        />
        {word !== "" && <span class="section-number-unit">{word}</span>}
      </span>
      {error ? (
        <FieldError save={save} field={row.name} />
      ) : (
        <span class="hint">{words.text}</span>
      )}
    </label>
  );
}

export function LimitsSection({
  rows,
  scope,
  title,
  text,
  off = false,
}: {
  rows: LimitRow[];
  scope: LimitScope;
  title: string;
  text: string;
  // the limits do nothing now: they stay as saved and cannot change
  off?: boolean;
}) {
  const { own, draft, form, save, submit, reset, changed, type } =
    useLimitsForm(rows, scope);
  const busy = save.busy || off;
  return (
    <Section title={title} text={text} off={off}>
      <SectionForm onSubmit={submit} formRef={form}>
        <div class="section-grid">
          {own.map((row) => (
            <LimitField
              key={row.name}
              row={row}
              text={draft.value[row.name] ?? ""}
              busy={busy}
              save={save}
              onInput={(text) => type(row.name, text)}
            />
          ))}
        </div>
        <Foot
          save={save}
          dirty={!off && dirty(own, draft.value)}
          label="Save"
          after={
            <button
              type="button"
              class="btn"
              disabled={busy || !changed}
              onClick={() => void reset()}
            >
              {save.pending.value === "reset the limits"
                ? "Resetting"
                : "Reset to defaults"}
            </button>
          }
        />
      </SectionForm>
    </Section>
  );
}
