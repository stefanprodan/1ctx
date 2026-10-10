// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { AUTOMATION_DEFAULTS } from "../../../src/shared/automation-defaults.ts";
import type { AutomationDraft } from "../../../src/shared/contracts/automation-draft.ts";

export const pendingDraft: AutomationDraft = {
  id: "draft",
  sendId: "send",
  messageId: "tool",
  action: "create",
  fields: {
    ...AUTOMATION_DEFAULTS,
    name: "proposed",
    instructions: "Check and report failures.",
    schedule: "0 9 * * *",
    tz: "UTC",
    agentId: "agent",
    disabledCapabilities: [],
  },
  automationId: null,
  agentId: "agent",
  state: "pending",
  askedBy: { id: "user", username: "casey" },
  decidedBy: null,
  decidedAt: null,
  createdAutomationId: null,
  runSessionId: null,
  createdAt: 100,
  expiresAt: 86_400_100,
};
