// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A group of base.css choices, each a label over a line of text, the
// picked one lit.

export type ChoiceOption<T extends string> = {
  value: T;
  label: string;
  text: string;
};

export function Choices<T extends string>({
  name,
  options,
  value,
  disabled,
  title,
  onPick,
}: {
  name?: string;
  options: ChoiceOption<T>[];
  value: T;
  disabled: boolean;
  title?: string;
  onPick: (value: T) => void;
}) {
  return (
    <div class="choices">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          name={name}
          aria-pressed={value === option.value}
          disabled={disabled}
          title={title}
          class={`choice${value === option.value ? " choice-on" : ""}`}
          onClick={() => onPick(option.value)}
        >
          <span class="choice-label">{option.label}</span>
          <span class="choice-text">{option.text}</span>
        </button>
      ))}
    </div>
  );
}
