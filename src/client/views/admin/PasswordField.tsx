// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A password an admin sets for someone else, New user's and the reset's:
// one box holding Generate, Show and Copy, as a number box holds its
// unit. The admin hands it over and the person changes it at first
// sign-in, so it is typed once. Generate shows what it made, so it can
// be read off. The label names the box alone, not its buttons.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { Icon } from "../../lib/icons.tsx";
import type { Save } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { generatePassword } from "./Users.model.ts";
import "./users.css";

export function PasswordField({
  id,
  name,
  label,
  value,
  save,
  onChange,
}: {
  // the box's id, for its label
  id: string;
  // the field a refusal names
  name: string;
  label: string;
  value: string;
  save: Save;
  onChange: (value: string) => void;
}) {
  const shown = useSignal(false);
  const copied = useSignal(false);
  // a box emptied by a save hides again, so the next one is not shown
  useEffect(() => {
    if (value === "") {
      shown.value = false;
      copied.value = false;
    }
  }, [value]);
  const invalid = save.fieldError(name) !== null;
  const set = (next: string) => {
    copied.value = false;
    onChange(next);
    save.touch();
  };
  return (
    <div class="field">
      <label class="label label-required" for={id}>
        {label}
      </label>
      <span class={`users-password${invalid ? " users-password-invalid" : ""}`}>
        <input
          id={id}
          name={name}
          class="users-password-input"
          type={shown.value ? "text" : "password"}
          autocomplete="new-password"
          spellcheck={false}
          aria-invalid={invalid || undefined}
          disabled={save.busy}
          value={value}
          onInput={(e) => set((e.currentTarget as HTMLInputElement).value)}
        />
        <button
          type="button"
          class="btn-icon"
          title="Generate"
          aria-label="Generate"
          disabled={save.busy}
          onClick={() => {
            shown.value = true;
            set(generatePassword());
          }}
        >
          <Icon name="redo" size={14} />
        </button>
        <button
          type="button"
          class="btn-icon"
          title={shown.value ? "Hide" : "Show"}
          aria-label={shown.value ? "Hide" : "Show"}
          onClick={() => {
            shown.value = !shown.value;
          }}
        >
          <Icon name={shown.value ? "eye-off" : "eye"} size={14} />
        </button>
        <button
          type="button"
          class="btn-icon"
          title={copied.value ? "Copied" : "Copy"}
          aria-label={copied.value ? "Copied" : "Copy"}
          disabled={value === ""}
          onClick={() => {
            void navigator.clipboard
              .writeText(value)
              .then(() => {
                copied.value = true;
              })
              .catch(() => {});
          }}
        >
          <Icon name={copied.value ? "check" : "copy"} size={14} />
        </button>
      </span>
      <FieldError save={save} field={name} />
    </div>
  );
}
