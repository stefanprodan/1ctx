// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the automation routes. Anyone who
// sees the project creates, runs, suspends and resumes; the owner or,
// in a team project, an admin edits and deletes.

import type { AutomationSummary } from "../contracts/automation.ts";
import type { SessionStatus } from "../words.ts";
import type { StreamRow } from "./sessions.ts";

// GET /api/projects/:id/automations: the project's rows, by name, and
// the run deadline limit, the deadline a row with none runs under
export type AutomationsResponse = {
  automations: AutomationSummary[];
  runDeadlineMs: number;
};

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

// GET /api/automations/:id/runs?filter=failed|manual: its sessions,
// newest first, at most the stream's limit, narrowed by the filter;
// the tally counts every kept run by status, whatever the filter.
// POST /api/automations/:id/run answers 201 with the run's
// SessionResponse
export type AutomationRunsResponse = { rows: StreamRow[]; tally: RunTally };
export type RunTally = Record<SessionStatus, number>;

// GET /api/projects/:id/automations/preview?schedule=&tz=: the next
// fires from now, at most PREVIEW_FIRES, or the 400 a save would get
export type SchedulePreviewResponse = { fires: number[] };
