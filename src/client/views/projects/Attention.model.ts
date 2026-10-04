// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Who marks an automation's runs as needing attention, as the editor's
// Needs attention step and the page's Setup say it: the three modes,
// which of them a pick can take, and why one cannot.

import type { AttentionMode } from "../../../shared/words.ts";

export const ATTENTION_LABELS: Record<AttentionMode, string> = {
  off: "Off",
  agent: "Agent",
  decider: "Decider",
};

const ORDER: readonly AttentionMode[] = ["off", "agent", "decider"];

// the switch's options: Agent needs a model that calls tools, and
// Decider the instance's decider, though a saved pick stays shown
export function attentionOptions(input: {
  takesTools: boolean;
  deciderOn: boolean;
  off: boolean;
}): { value: AttentionMode; label: string; disabled: boolean }[] {
  return ORDER.map((value) => ({
    value,
    label: ATTENTION_LABELS[value],
    disabled:
      input.off ||
      (value === "agent" && !input.takesTools) ||
      (value === "decider" && !input.deciderOn),
  }));
}

// the line under the switch when a mode cannot be picked, the agent's
// reason first, null when every one can
export function attentionHint(input: {
  takesTools: boolean;
  deciderOn: boolean;
}): string | null {
  const lines = [
    ...(input.takesTools
      ? []
      : ["This agent does not call tools, so it cannot mark its runs."]),
    ...(input.deciderOn ? [] : ["The decider is off."]),
  ];
  return lines.length === 0 ? null : lines.join(" ");
}

// the words on when, shown only where something reads them: the
// agent's tool, or the decider in its mode
export function guidanceShown(input: {
  mode: AttentionMode;
  takesTools: boolean;
}): boolean {
  if (input.mode === "off") return false;
  return input.mode === "decider" || input.takesTools;
}
