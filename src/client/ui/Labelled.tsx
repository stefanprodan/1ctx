// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A field whose control is no input of its own (a Seg, a Select, a
// picker): its label over it, and its hint under it until a refusal
// names the field, which FieldError then draws in the hint's place.
// Only base.css's field classes, so it needs no stylesheet.

import type { ComponentChildren } from "preact";
import type { Save } from "../lib/save.ts";
import { FieldError } from "./FieldError.tsx";

export function Labelled({
  label,
  field,
  save,
  required,
  hint,
  children,
}: {
  label: string;
  field: string;
  save: Pick<Save, "fieldError">;
  required?: boolean;
  hint?: string;
  children: ComponentChildren;
}) {
  return (
    <div class="field">
      <span class={`label${required ? " label-required" : ""}`}>{label}</span>
      {children}
      {save.fieldError(field) !== null ? (
        <FieldError save={save} field={field} />
      ) : (
        hint !== undefined && <span class="hint">{hint}</span>
      )}
    </div>
  );
}
