// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words on a feed row, from what the server said: the state
// line under the title and the time on the right. Nothing here reads
// a transcript; the send's counters, its cause and the last line come
// on the row.

import type { FeedRow } from "../../shared/api/sessions.ts";
import type { AutomationAlert } from "../../shared/contracts/automation.ts";
import { ATTENTION_AT } from "../../shared/contracts/decision.ts";
import type { SessionSummary } from "../../shared/contracts/session.ts";
import { ago, clock, dayMonth, elapsed, plural } from "../lib/format.ts";

// the first line of an error, so a provider's paragraph stays a line
const firstLine = (text: string): string =>
  text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";

// the line under the title: the last line with its author, who is
// drawn apart, or the state of a send that did not finish
export type StateLine = { author: string | null; text: string };

const plain = (text: string): StateLine => ({ author: null, text });

// the row's icon: the clock for an automation's run, the bubble for a
// chat, the box for an archived chat
export function iconOf(row: FeedRow): "clock" | "chat" | "archive" {
  if (row.session.archived !== null) return "archive";
  return row.session.origin === "automation" ? "clock" : "chat";
}

// the quiet word before the line: an archived chat, or a restart run
export function markOf(row: FeedRow): string | null {
  if (row.session.archived !== null) return "archived";
  return row.session.runSource === "restart" ? "restarted" : null;
}

// a run its agent or the runner marked, or a decider judged to need a
// person; a run not marked, a chat and a chance under the mark say
// nothing
export const ATTENTION_WORDS = "flagged";
export const needsAttention = (
  session: Pick<SessionSummary, "attention">,
): boolean => session.attention !== null && session.attention >= ATTENTION_AT;

// whether a row says flagged: a failed run's red words already say it
export const flagShown = (
  session: Pick<SessionSummary, "attention" | "status">,
): boolean => needsAttention(session) && session.status !== "failed";

// the reason a row draws after the mark: the agent's; the runner's only
// repeats the status line, and a decider gives none
export const markReason = (
  session: Pick<SessionSummary, "attentionReason" | "attentionSource">,
): string | null =>
  session.attentionSource === "runner" ? null : session.attentionReason;

// when an open alert began: the time of day today, else the day too
export function sinceText(since: number, now: number): string {
  const sameDay =
    new Date(since).toDateString() === new Date(now).toDateString();
  return sameDay ? clock(since) : `${dayMonth(since)} ${clock(since)}`;
}

// an open alert's span: "since 08:41, 3 runs"
export const alertSpan = (alert: AutomationAlert, now: number): string =>
  `since ${sinceText(alert.since, now)}, ${plural(alert.runs, "run")}`;

// an automation's open alert on its line: "flagged since
// 08:41, 3 runs", the latest reason drawn after it
export const alertWords = (alert: AutomationAlert, now: number): string =>
  `${ATTENTION_WORDS} ${alertSpan(alert, now)}`;

// the open alert a line shows in place of its run's state: on an
// automation's one line, in All and in the Flagged pick
export const alertOf = (row: FeedRow, line: boolean): AutomationAlert | null =>
  line ? (row.automation?.alert ?? null) : null;

// the icon's colour: a marked run that finished wears the mark's, a
// failed or stopped one keeps its own status
export const iconStatus = (
  session: Pick<SessionSummary, "attention" | "status">,
): string =>
  needsAttention(session) && session.status === "done"
    ? "attention"
    : session.status;

// whether the line's author is the session's agent or the last send's,
// since deleted: the name is greyed, with no tag, since rows are dense
export function authorGone(row: FeedRow, line: StateLine): boolean {
  if (line.author === null) return false;
  // a live retire sets agentRetired alone, so the send's flag only adds
  if (row.sendAgent?.retired && line.author === row.sendAgent.name) {
    return true;
  }
  return row.agentRetired && line.author === row.agent;
}

export function stateLine(row: FeedRow): StateLine {
  const { session, send, last } = row;
  // a send that did not finish is its agent's, the summoned one's for a
  // summoned turn, so its state is credited to the agent the way a last
  // line is to its author
  const author = row.sendAgent?.name ?? row.agent;
  const agent = (text: string): StateLine => ({ author, text });
  switch (session.status) {
    case "running": {
      const calls = send?.toolCalls ?? 0;
      if (calls === 0) return agent("working");
      return agent(`working · ${calls} tool ${calls === 1 ? "call" : "calls"}`);
    }
    case "failed": {
      const error = send?.error === null ? "" : firstLine(send?.error ?? "");
      return agent(error === "" ? "failed" : `failed · ${error}`);
    }
    case "stopped":
      return agent(
        send?.cause === "shutdown" || send?.cause === "restart"
          ? "stopped · the server restarted"
          : send?.cause === "deadline"
            ? "stopped · past its deadline"
            : "stopped",
      );
    default:
      return last === null
        ? plain("")
        : { author: last.author, text: last.text };
  }
}

// the send's elapsed time while it runs, else how long ago the last
// activity was
export function whenText(row: FeedRow, now: number): string {
  const { session, send } = row;
  if (session.status === "running") {
    return elapsed(now - (send?.startedAt ?? session.lastActivityAt));
  }
  return ago(session.lastActivityAt, now);
}

// the running row's clock moves every second; the rest every half
// minute, the coarseness of ago()
export function tickMs(rows: FeedRow[] | null): number {
  return rows?.some((row) => row.session.status === "running") ? 1000 : 30_000;
}
