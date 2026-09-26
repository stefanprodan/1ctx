// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agent form's chips: one row of choices, the chosen one lit.
// `name` goes on every button, so a refusal can focus the row.

import type { Choice } from "./Agents.model.ts";
import "./agents.css";

export function Picks<T extends string | null>({
  name,
  choices,
  value,
  busy,
  onPick,
}: {
  name?: string;
  choices: Choice<T>[];
  value: T;
  busy: boolean;
  onPick: (value: T) => void;
}) {
  return (
    <div class="agents-picks">
      {choices.map((choice) => (
        <button
          key={choice.value ?? "default"}
          type="button"
          name={name}
          aria-pressed={value === choice.value}
          disabled={busy}
          class={`agents-pick${
            value === choice.value ? " agents-pick-on" : ""
          }`}
          onClick={() => onPick(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}
