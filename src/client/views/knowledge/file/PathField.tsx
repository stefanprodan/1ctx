// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The path of a new or renamed file, one field in the card's band, the
// server's refusal under it.

import type { ComponentChildren } from "preact";
import type { Save } from "../../../lib/save.ts";
import { FieldError } from "../../../ui/FieldError.tsx";

export function PathField({
  value,
  save,
  placeholder,
  onInput,
  children,
}: {
  value: string;
  save: Pick<Save, "fieldError">;
  placeholder: string;
  onInput: (value: string) => void;
  // what sits after the field, the size of a new file
  children?: ComponentChildren;
}) {
  const error = save.fieldError("path");
  return (
    <>
      <label class="docpage-name">
        <span class="label">Path</span>
        <span class="field docpage-name-box">
          <input
            class="docpage-path"
            name="path"
            value={value}
            placeholder={placeholder}
            spellcheck={false}
            autocomplete="off"
            autocapitalize="off"
            aria-invalid={error !== null ? true : undefined}
            onInput={(ev) => onInput(ev.currentTarget.value)}
          />
          <FieldError save={save} field="path" />
        </span>
      </label>
      {children}
    </>
  );
}
