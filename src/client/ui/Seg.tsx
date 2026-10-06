// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A segmented switch of a few options, one picked: base's `.seg` as a
// group of pressed buttons. RowsFilters is the card head's own.

import type { ComponentChildren } from "preact";

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
  invalid,
  name,
  class: extra,
}: {
  label: string;
  options: readonly SegOption<T>[];
  value: T;
  onPick: (value: T) => void;
  small?: boolean;
  invalid?: boolean;
  // the picked option carries it, so a refusal's focus finds the switch
  name?: string;
  class?: string;
}) {
  const cls = `seg${small ? " seg-small" : ""}${invalid ? " seg-invalid" : ""}${
    extra ? ` ${extra}` : ""
  }`;
  return (
    <fieldset class={cls} aria-label={label}>
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
  );
}
