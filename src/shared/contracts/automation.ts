// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An automation as the wire exposes it: a standing question in a
// project, asked of an agent on a cron schedule in a zone. The last
// event (a fire, run or skipped) and the last run (a session) are kept
// apart, so a skip never hides a run in flight. The revision counts the
// row's writes; a client applies an event only when its revision is
// above the one it holds.

import type { EventOutcome, EventSource, SessionStatus } from "../words.ts";

export type AutomationSummary = {
  id: string;
  projectId: string;
  // who made it, and whom a scheduled run acts as
  ownerId: string;
  // the owner's username, an admin outside the project included
  ownerName: string;
  agentId: string;
  // the agent's name, kept once it is deleted; retired is true then,
  // and the automation stays paused until an edit picks a live agent
  agentName: string;
  agentRetired: boolean;
  name: string;
  instructions: string;
  schedule: string;
  tz: string;
  // null for the limit's value
  deadlineMs: number | null;
  retentionDays: number;
  // its runs end with a memory phase that keeps the automation's note
  ownMemory: boolean;
  // what its runs have turned off, sorted keys of shared/capabilities.ts
  disabledCapabilities: string[];
  memoryGuidance: string;
  // an epoch while suspended; nextAt is null exactly then
  suspendedAt: number | null;
  // who suspended it, an admin outside the project included; null while
  // it runs, and for a row suspended before this was kept
  suspendedBy: { id: string; username: string } | null;
  nextAt: number | null;
  lastEventAt: number | null;
  // the fire that was meant; later than lastEventAt means it ran late
  lastEventDueAt: number | null;
  lastEventSource: EventSource | null;
  lastEventOutcome: EventOutcome | null;
  // why an event was skipped; null for a run
  lastEventReason: string | null;
  // null once the session is deleted
  lastRunSessionId: string | null;
  lastRunStatus: SessionStatus | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

// a fire starts within milliseconds; the grace covers that and a clock
// a little ahead. A row due longer than this waits for a run slot
export const WAIT_GRACE_MS = 10_000;
