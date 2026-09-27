// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Whether an agent or a decider is the default: the agent a new chat
// starts on for anyone who has not picked one, the decider every
// feature asks. No on the default hands it back to the oldest row, so
// the oldest, while it is the default, has no No.

import type { Signal } from "@preact/signals";
import type { Save } from "../../lib/save.ts";
import type { Choice } from "./Agents.model.ts";
import { Picks } from "./Picks.tsx";

const DEFAULT_CHOICES: Choice<"on" | "off">[] = [
  { value: "on", label: "Yes" },
  { value: "off", label: "No" },
];

const AGENT_HINT = "New chats start on it until a user picks another agent.";

export function DefaultField({
  row,
  on,
  save,
  oldest,
  label = "Default agent",
  hint = AGENT_HINT,
}: {
  // null for a new row
  row: { id: string } | null;
  on: Signal<boolean>;
  save: Pick<Save, "busy" | "touch">;
  // the id at the head of its list, oldest first: the default when
  // none is marked
  oldest: string | undefined;
  label?: string;
  hint?: string;
}) {
  const kept = row !== null && on.value && oldest === row.id;
  return (
    <div class="field">
      <span class="label">{label}</span>
      <Picks
        name="default"
        choices={DEFAULT_CHOICES}
        value={on.value ? "on" : "off"}
        busy={save.busy || kept}
        onPick={(value) => {
          on.value = value === "on";
          save.touch();
        }}
      />
      <span class="hint">{hint}</span>
    </div>
  );
}
