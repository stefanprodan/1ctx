// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agent form's chips: one row of choices, the chosen one lit, as
// the provider picker draws them.

import type { Choice } from "./Agents.model.ts";
import "./agents.css";

export function Picks<T extends string | null>({
  choices,
  value,
  busy,
  onPick,
}: {
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
