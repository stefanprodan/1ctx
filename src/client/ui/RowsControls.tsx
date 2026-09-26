// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The controls of a list's rows, kept apart from Rows.tsx for its size
// and exported through it: a card head's filters, and a row's end with
// its switch, radio and box.

import type { ComponentChildren } from "preact";
import { Icon, type IconName } from "../lib/icons.tsx";
import "./rows.css";

// a card head's few filters, one lit: links when each is an address,
// buttons when the page holds the pick
export type RowsFilter = {
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

// the row's end: its buttons, after the words that ask or the failure
// of the last try; under 720 an end with words wraps below the head,
// and any end that does not fit beside the name wraps below it
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

// a server-wide switch at a row's end
export function RowsSwitch({
  on,
  label,
  disabled,
  onClick,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${label} ${on ? "on" : "off"}`}
      class={`switch${on ? " switch-on" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span class="switch-knob" />
    </button>
  );
}

// a pick of one, first in a label row
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

// a box: first in a label row, or with its words at a row's end. The
// native box stays for the keyboard and a screen reader, drawn over.
export function RowsCheck({
  name,
  value,
  checked,
  disabled,
  faint,
  note,
  onChange,
  children,
}: {
  name: string;
  value?: string;
  checked: boolean;
  disabled?: boolean;
  // the side cannot take effect: its words go faint, the note says why
  faint?: boolean;
  note?: string;
  onChange: () => void;
  // the words beside the box; without them the row is the label
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
      onChange={onChange}
    />
  );
  if (children === undefined) {
    return (
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
