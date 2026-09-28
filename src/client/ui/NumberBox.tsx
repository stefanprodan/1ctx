// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

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
  label?: string;
  // a refusal's focus finds the box by it
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
