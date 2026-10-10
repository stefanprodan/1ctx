// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AutomationSummary } from "./contracts/automation.ts";

export const OWN_MEMORY_GUIDANCE =
  "Keep a few topics that each hold a short list, and update them in place: what worked and what failed and why, where the information lives, and the state the check found (versions, counts, names), without times or dates. Change a topic only when a fact in it changed, and call none when the run found the same state. Add an item to its list instead of making a topic for it, and drop the oldest items when the note is full. Leave out the answer itself, anything copied from the task, and errors that went away. Leave out what the run reads from files or its task on every run.";

export const AUTOMATION_DEFAULTS = {
  deadlineMs: null,
  retentionDays: 30,
  ownMemory: true,
  memoryGuidance: OWN_MEMORY_GUIDANCE,
  attentionMode: "agent",
  attentionGuidance: "",
  rerunOnRestart: false,
  once: false,
} satisfies Partial<AutomationSummary>;
