// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentChildren } from "preact";
import { Icon, type IconName } from "../lib/icons.tsx";
import "./rows.css";

type RowsFilter = {
  label: string;
  on: boolean;
  icon?: IconName;
  href?: string;
  onPick?: () => void;
};

export function RowsFilters({
  label,
  filters,
}: {
  label: string;
  filters: RowsFilter[];
}) {
  return (
    <nav class="seg seg-small rows-filters" aria-label={label}>
      {filters.map((f) => {
        const cls = `seg-option${f.on ? " seg-on" : ""}`;
        const inner = (
          <>
            {f.icon && <Icon name={f.icon} size={12} />}
            {f.label}
          </>
        );
        return f.href !== undefined ? (
          <a
            key={f.label}
            class={cls}
            href={f.href}
            aria-current={f.on ? "page" : undefined}
          >
            {inner}
          </a>
        ) : (
          <button
            key={f.label}
            type="button"
            class={cls}
            aria-pressed={f.on}
            onClick={f.onPick}
          >
            {inner}
          </button>
        );
      })}
    </nav>
  );
}

export function RowsEnd({
  words,
  error,
  children,
}: {
  words?: string;
  error?: string | null;
  children?: ComponentChildren;
}) {
  return (
    <span class={`rows-end${words || error ? " rows-end-ask" : ""}`}>
      {error ? (
        <span class="rows-end-error error" role="alert">
          {error}
        </span>
      ) : (
        words && <span class="rows-end-words">{words}</span>
      )}
      {children}
    </span>
  );
}

export function RowsSwitch({
  on,
  label,
  disabled,
  title,
  name,
  onClick,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  // why it is off, for a switch that cannot be turned
  title?: string;
  // so a refusal can take the focus here
  name?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      name={name}
      aria-checked={on}
      aria-label={`${label} ${on ? "on" : "off"}`}
      class={`switch${on ? " switch-on" : ""}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <span class="switch-knob" />
    </button>
  );
}

export function RowsRadio({
  name,
  value,
  checked,
  disabled,
  onChange,
}: {
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <input
      class="rows-radio"
      type="radio"
      name={name}
      value={value}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

// the native box stays for the keyboard and a screen reader, drawn over
export function RowsCheck({
  name,
  value,
  checked,
  disabled,
  faint,
  note,
  label,
  onChange,
  children,
}: {
  name: string;
  value?: string;
  checked: boolean;
  disabled?: boolean;
  faint?: boolean;
  note?: string;
  // a box alone, with no words nor a label row: it is its own label
  label?: string;
  onChange: () => void;
  children?: ComponentChildren;
}) {
  const box = (
    <span
      class={`rows-check-box${checked ? " rows-check-on" : ""}`}
      aria-hidden="true"
    >
      {checked && <Icon name="check" size={12} />}
    </span>
  );
  const input = (
    <input
      type="checkbox"
      class="rows-check-input"
      name={name}
      value={value}
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={onChange}
    />
  );
  if (children === undefined) {
    // a box of its own, outside a label row, is its own label, so a
    // click on the drawn box reaches the input under it
    return label !== undefined ? (
      // biome-ignore lint/a11y/noLabelWithoutControl: the input is inside, built once above
      <label class="rows-check">
        {input}
        {box}
      </label>
    ) : (
      <span class="rows-check">
        {input}
        {box}
      </span>
    );
  }
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the input is inside, built once above
    <label
      class={`rows-check rows-check-words${faint ? " rows-check-faint" : ""}`}
    >
      {input}
      {box}
      {children}
      {note && <span class="rows-check-note">{note}</span>}
    </label>
  );
}

export function RowsRemove({
  name,
  disabled,
  onRemove,
}: {
  name: string;
  disabled?: boolean;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      class="btn-icon rows-remove"
      aria-label={`Remove ${name}`}
      title="Remove"
      disabled={disabled}
      onClick={onRemove}
    >
      <Icon name="close" size={14} />
    </button>
  );
}
