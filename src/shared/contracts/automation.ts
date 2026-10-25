// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An automation as the wire exposes it: a standing question in a
// project, asked of an agent on a cron schedule in a zone. The last
// event (a fire, run or skipped) and the last run (a session) are kept
// apart, so a skip never hides a run in flight. The revision counts the
// row's writes; a client applies an event only when its revision is
// above the one it holds. The edit revision counts only the saves that
// changed a field; an edit names the one it started from.

import {
  type AttentionMode,
  type EventOutcome,
  type EventSource,
  MAX_MCP_URL,
  type SessionStatus,
} from "../words.ts";

export type AutomationSummary = {
  id: string;
  projectId: string;
  // who last saved a change to it, or made it, and whom a scheduled
  // run acts as
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
  // who marks its runs as needing attention, and its words on when,
  // which its agent and the decider read
  attentionMode: AttentionMode;
  attentionGuidance: string;
  // the open alert, null while none is open
  alert: AutomationAlert | null;
  // a scheduled run starts only on a new answer
  checkUrl: string | null;
  lastCheckedAt: number | null;
  lastCheckResult: CheckResult | null;
  // the last answer, or when the URL was set: silence counts from it
  lastAnsweredAt: number | null;
  // a run a restart cut starts again at the next start
  rerunOnRestart: boolean;
  // a run that ends done with an answer posts it to the project's
  // channel; never on in a personal project, which has none
  postToChannel: boolean;
  // the first fire that starts a run suspends it; resume arms it again
  once: boolean;
  // when that fire suspended it, equal to suspendedAt until a resume
  // clears it; null while it has not fired
  onceFiredAt: number | null;
  // the run that fire started; null once the session is deleted
  onceRunSessionId: string | null;
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
  editRevision: number;
  createdAt: number;
  updatedAt: number;
};

// An automation's open alert: since when, how many of its runs were
// marked since then, and the latest one's reason, null for a decider's.
// Its runs are those marked runs; no row holds them
export type AutomationAlert = {
  since: number;
  runs: number;
  // the latest reason any of its runs gave; null when only a decider
  // marked them
  reason: string | null;
  // who marked its latest run
  by: string | null;
  // a failed check opened or joined it; the reason is the check's while
  // no marked run is newer
  check: boolean;
};

// an MCP server's URL rule, its length included
export const MAX_CHECK_URL = MAX_MCP_URL;
// a failed check opens the alert only after this long unanswered
export const CHECK_SILENCE_MS = 30 * 60_000;

// nothing new: 204, 304, an empty 200 or the same body as the last run's
export const CHECK_QUIET = ["204", "304", "empty", "unchanged"] as const;
// shown after "Check failed 3m ago: "
export const CHECK_FAILURES = [
  "redirected outside its credential's URL",
  "redirected away from its MCP server",
  "too many redirects",
  "timed out",
  "could not connect",
  "answer too large",
  "answer is not text",
  "web access is off",
  "host is not in Web access",
  "its credential is turned off",
  "its credential has no key",
  "its credential does not allow GET",
] as const;
export type CheckQuiet = (typeof CHECK_QUIET)[number];
export type CheckFailure = (typeof CHECK_FAILURES)[number] | `HTTP ${number}`;
// "200" is a new answer
export type CheckResult = "200" | CheckQuiet | CheckFailure;

export const isCheckQuiet = (result: string): result is CheckQuiet =>
  (CHECK_QUIET as readonly string[]).includes(result);

export const isCheckFailure = (result: string): result is CheckFailure =>
  (CHECK_FAILURES as readonly string[]).includes(result) ||
  /^HTTP \d{3}$/.test(result);

export const CHECK_ALERT_LEAD = "The check failed: ";

// the skipped event's reason for a failed check
export function checkReason(result: CheckFailure): string {
  switch (result) {
    case "timed out":
    case "could not connect":
      return `check ${result}`;
    case "answer too large":
    case "answer is not text":
      return result;
    default:
      return `check failed: ${result}`;
  }
}

// its own fire suspended it and its run is kept: what the page says
// "Ran once" for and what a restart may rerun while suspended. Whether
// once is still set does not matter
export function ranOnce(
  a: Pick<
    AutomationSummary,
    "suspendedAt" | "onceFiredAt" | "onceRunSessionId"
  >,
): boolean {
  return (
    a.suspendedAt !== null &&
    a.suspendedAt === a.onceFiredAt &&
    a.onceRunSessionId !== null
  );
}

// a PATCH whose edit revision the row has moved past; nothing is written
export const STALE_EDIT = "changed since you opened it";

// a fire starts within milliseconds; the grace covers that and a clock
// a little ahead. A row due longer than this waits for a run slot
export const WAIT_GRACE_MS = 10_000;
