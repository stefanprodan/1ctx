// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export const refusedProposalFields = [
  { action: "create", id: "task" },
  { action: "create", agentId: "agent" },
  { action: "create", deadlineMs: 1 },
  { action: "create", disabledCapabilities: [] },
  { action: "update", id: "task", agentId: "agent" },
  { action: "update", id: "task", retentionDays: 30 },
  { action: "suspend", id: "task", name: "new" },
  { action: "resume", id: "task", once: true },
  { action: "run", id: "task", instructions: "check" },
] as const;

export const refusedTaskValues = [
  { name: "" },
  { name: "x".repeat(81) },
  { instructions: " " },
  { instructions: "x".repeat(256 * 1024 + 1) },
  { once: "true" },
  { schedule: "" },
  { tz: "" },
  { deadlineMs: 0 },
  { retentionDays: 0 },
  { ownMemory: "yes" },
  { attentionMode: "other" },
] as const;
