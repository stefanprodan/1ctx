// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agent form's effort: a native select over the wire's levels,
// the empty option leaving the provider's default in place.

import type { Effort, Wire } from "../../../shared/words.ts";
import { Icon } from "../../lib/icons.tsx";
import { effortChoices } from "./Agents.model.ts";
import "./agents.css";

export function EffortField({
  wire,
  value,
  busy,
  onChange,
}: {
  wire: Wire;
  value: Effort | null;
  busy: boolean;
  onChange: (value: Effort | null) => void;
}) {
  return (
    <label class="field">
      <span class="label">Effort</span>
      <span class="agents-select">
        <select
          name="effort"
          class="agents-select-input"
          disabled={busy}
          onChange={(e) => {
            const picked = (e.currentTarget as HTMLSelectElement).value;
            onChange(picked === "" ? null : (picked as Effort));
          }}
        >
          {effortChoices(wire).map((choice) => (
            // Preact sets no default on a select, so the option carries
            // the selection
            <option
              key={choice.value ?? ""}
              value={choice.value ?? ""}
              selected={value === choice.value}
            >
              {choice.label}
            </option>
          ))}
        </select>
        <Icon name="chevron" size={14} class="agents-select-chevron" />
      </span>
    </label>
  );
}
