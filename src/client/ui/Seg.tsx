// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A segmented switch of a few options, one picked: base's `.seg` as a
// group of pressed buttons. RowsFilters is the card head's own; a
// small one in a card's head is a dropdown on a phone, as they are.

import type { ComponentChildren } from "preact";
import { Select } from "./Select.tsx";
import "./rows.css";

type SegOption<T extends string> = {
  value: T;
  label: ComponentChildren;
  disabled?: boolean;
  title?: string;
};

export function Seg<T extends string>({
  label,
  options,
  value,
  onPick,
  small,
  head,
  invalid,
  name,
  class: extra,
}: {
  label: string;
  options: readonly SegOption<T>[];
  value: T;
  onPick: (value: T) => void;
  small?: boolean;
  // in a card's head: a phone shows the head's dropdown, so the head
  // keeps one line
  head?: boolean;
  invalid?: boolean;
  // the picked option carries it, so a refusal's focus finds the switch
  name?: string;
  class?: string;
}) {
  const cls = `seg${small ? " seg-small" : ""}${invalid ? " seg-invalid" : ""}${
    extra ? ` ${extra}` : ""
  }`;
  const words = options.every((o) => typeof o.label === "string");
  const pick = head && words && (
    <span class="rows-filters-pick">
      <Select
        label={label}
        quiet
        value={value}
        options={options.map((o) => ({
          value: o.value,
          label: o.label as string,
          disabled: o.disabled,
        }))}
        onChange={(v) => onPick(v as T)}
      />
    </span>
  );
  return (
    <>
      {pick}
      <fieldset
        class={`${cls}${pick ? " rows-filters" : ""}`}
        aria-label={label}
      >
        {options.map((option) => {
          const on = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              name={on ? name : undefined}
              class={`seg-option${on ? " seg-on" : ""}`}
              aria-pressed={on}
              disabled={option.disabled}
              title={option.title}
              // an icon has no words, so its tooltip names it; a worded
              // option's title only describes it
              aria-label={
                typeof option.label === "string" ? undefined : option.title
              }
              onClick={() => onPick(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </fieldset>
    </>
  );
}
