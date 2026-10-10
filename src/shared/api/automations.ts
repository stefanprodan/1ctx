// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the automation routes. Anyone who
// sees the project creates, runs, suspends, resumes, edits and deletes;
// a save that changes a field makes its editor the owner.

import type { AutomationSummary } from "../contracts/automation.ts";
import type { AttentionMode, SessionStatus } from "../words.ts";
import type { FeedRow } from "./sessions.ts";

// GET /api/projects/:id/automations: the project's rows, by name, and
// the run deadline limit, the deadline a row with none runs under, and
// whether the instance's run-attention decision is on with a decider to
// ask, which the decider mode needs
export type AutomationsResponse = {
  automations: AutomationSummary[];
  runDeadlineMs: number;
  deciderOn: boolean;
};

// POST /api/projects/:id/automations (201), GET, PATCH and
// POST /api/automations/:id/suspend|resume answer the row
export type AutomationResponse = { automation: AutomationSummary };

// POST /api/projects/:id/automations: guidance defaults to empty and
// the attention mode to agent; PATCH
// /api/automations/:id: any of them, each given one checked, and the
// edit revision the form started from, a 409 once the row moved on
export type SaveAutomationRequest = {
  name: string;
  agentId: string;
  instructions: string;
  schedule: string;
  tz: string;
  // null for the limit's value, else at most the limit
  deadlineMs: number | null;
  retentionDays: number;
  ownMemory: boolean;
  // the whole set, empty when absent on create
  disabledCapabilities?: string[];
  memoryGuidance?: string;
  // false when absent on create
  rerunOnRestart?: boolean;
  attentionMode?: AttentionMode;
  attentionGuidance?: string;
};
export type PatchAutomationRequest = Partial<SaveAutomationRequest> & {
  editRevision: number;
};

// GET /api/automations/:id/runs?filter=manual|attention&before=: a page of
// its sessions, newest first, narrowed by the filter, with next as for
// the feed; the tally counts every kept run by status, whatever the
// filter, on every page.
// POST /api/automations/:id/run answers 201 with the run's
// SessionResponse
export type AutomationRunsResponse = {
  rows: FeedRow[];
  tally: RunTally;
  next: string | null;
};
export type RunTally = Record<SessionStatus, number>;

// GET /api/projects/:id/automations/preview?schedule=&tz=: the next
// fires from now, at most PREVIEW_FIRES, or the 400 a save would get
export type SchedulePreviewResponse = { fires: number[] };
