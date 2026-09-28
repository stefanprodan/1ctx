// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

type ChoiceOption<T extends string> = {
  value: T;
  label: string;
  text: string;
};

export function Choices<T extends string>({
  options,
  value,
  disabled,
  onPick,
}: {
  options: ChoiceOption<T>[];
  value: T;
  disabled: boolean;
  onPick: (value: T) => void;
}) {
  return (
    <div class="choices">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
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
