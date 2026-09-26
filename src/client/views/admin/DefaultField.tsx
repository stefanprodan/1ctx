// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Whether the agent is the default: the one a new chat starts on for
// anyone with no favourite. No on the default hands it back to the
// oldest agent, so the oldest, while it is the default, has no No.

import type { Signal } from "@preact/signals";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import { agents } from "../../data/agents.ts";
import type { Save } from "../../lib/save.ts";
import type { Choice } from "./Agents.model.ts";
import { Picks } from "./Picks.tsx";

const DEFAULT_CHOICES: Choice<"on" | "off">[] = [
  { value: "on", label: "Yes" },
  { value: "off", label: "No" },
];

export function DefaultField({
  agent,
  on,
  save,
}: {
  // null for a new agent
  agent: AgentSummary | null;
  on: Signal<boolean>;
  save: Pick<Save, "busy" | "touch">;
}) {
  // the list is oldest first, so its head is the default when none is
  // marked
  const kept = agent !== null && on.value && agents.value?.[0]?.id === agent.id;
  return (
    <div class="field">
      <span class="label">Default agent</span>
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
      <span class="hint">
        {kept
          ? "The oldest agent is the default until another is made one."
          : "New chats start on it for anyone with no favourite."}
      </span>
    </div>
  );
}
