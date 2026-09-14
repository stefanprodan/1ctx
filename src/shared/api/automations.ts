// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the automation routes. Anyone who
// sees the project creates, runs, suspends and resumes; the owner or,
// in a team project, an admin edits and deletes.

import type { AutomationSummary } from "../contracts/automation.ts";
import type { StreamRow } from "./sessions.ts";

// GET /api/projects/:id/automations: the project's rows, by name
export type AutomationsResponse = { automations: AutomationSummary[] };

// POST /api/projects/:id/automations (201), GET, PATCH and
// POST /api/automations/:id/suspend|resume answer the row
export type AutomationResponse = { automation: AutomationSummary };

// POST /api/projects/:id/automations: every field; PATCH
// /api/automations/:id: any of them, each given one checked
export type SaveAutomationRequest = {
  name: string;
  agentId: string;
  instructions: string;
  schedule: string;
  tz: string;
  // null for the limit's value, else at most the limit
  deadlineMs: number | null;
  retentionDays: number;
};
export type PatchAutomationRequest = Partial<SaveAutomationRequest>;

// GET /api/automations/:id/runs: its sessions, newest first, at most
// the stream's limit. POST /api/automations/:id/run answers 201 with
// the run's SessionResponse
export type AutomationRunsResponse = { rows: StreamRow[] };
