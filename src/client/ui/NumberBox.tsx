// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A number typed as text with its unit inside the box: the limits on a
// settings page, a server's call timeout in its card. The caller parses
// the text and names the field, so a refusal's focus finds it.

import "./numberbox.css";

export function NumberBox({
  label,
  name,
  value,
  unit,
  placeholder,
  invalid,
  disabled,
  class: extra,
  onInput,
}: {
  // names the box aloud when no <label> holds it
  label?: string;
  name: string;
  value: string;
  unit: string;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  class?: string;
  onInput: (text: string) => void;
}) {
  return (
    <span
      class={`numberbox${invalid ? " numberbox-invalid" : ""}${
        extra ? ` ${extra}` : ""
      }`}
    >
      <input
        class="numberbox-input"
        name={name}
        aria-label={label}
        type="text"
        inputMode="decimal"
        autocomplete="off"
        spellcheck={false}
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        aria-invalid={invalid || undefined}
        onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
      />
      {unit !== "" && <span class="numberbox-unit">{unit}</span>}
    </span>
  );
}
