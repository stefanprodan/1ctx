// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a run's line says without a DOM: what started it, how long it
// took and against which deadline.

import type { FeedRow } from "../../../shared/api/sessions.ts";
import type { SessionSummary } from "../../../shared/contracts/session.ts";
import { pad } from "../../../shared/schedule.ts";

export const RESTART_WORDS = "Restarted";
// the run page's line over a restart run's transcript
export const RESTARTED_LINE = "Restarted after the server stopped";

// what started a run: "Scheduled", "@bogdan" for whoever pressed Run
// now, or "Restarted", the run icon's title; the name is the server's,
// so an admin outside the project is named too. A run from before
// sources were kept says nothing
export function sourceText(row: FeedRow): string {
  const { session } = row;
  if (session.runSource === "schedule") return "Scheduled";
  if (session.runSource === "restart") return RESTART_WORDS;
  if (session.runSource !== "manual" || row.runBy === null) return "";
  return `@${row.runBy.username}`;
}

// the run log's icon for what started a run: the clock for the schedule
// and for a run from before sources were kept
export function sourceIcon(
  session: Pick<SessionSummary, "runSource">,
): "clock" | "bolt" | "redo" {
  if (session.runSource === "manual") return "bolt";
  return session.runSource === "restart" ? "redo" : "clock";
}

// how long the run has taken, while it runs up to now; null before its
// send is on the row
export function durationOf(row: FeedRow, now: number): number | null {
  const { send } = row;
  if (send === null) return null;
  return Math.max(0, (send.finishedAt ?? now) - send.startedAt);
}

// "4m 10s", "38s", "1h 2m": a run's length to the second, since runs
// are minutes long and the list's one letter would say 4m for both
export function durationText(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m`;
}

// a deadline as the setup says it: "10 min", "90 s"
export function deadlineText(ms: number): string {
  return ms % 60_000 === 0
    ? `${ms / 60_000} min`
    : `${Math.round(ms / 1000)} s`;
}

// the part of the deadline a run took, 0 to 1
export function deadlineShare(ms: number, deadlineMs: number): number {
  if (deadlineMs <= 0) return 0;
  return Math.min(1, ms / deadlineMs);
}
