// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words of a run's page without a DOM: which automation it is a
// run of, for the line over the transcript and the foot, and the
// foot's state.

import type { FeedRow } from "../../../shared/api/sessions.ts";
import type { AutomationAlert } from "../../../shared/contracts/automation.ts";
import { needsAttention, stateLine, whenText } from "../../feed/Row.model.ts";
import { count } from "../../lib/format.ts";
import { automationHref } from "../../lib/hrefs.ts";
import { durationOf, durationText } from "../projects/Run.model.ts";

// the automation's name and its page; no page for one that was deleted
// or while the list is still loading
export type RunOf = { name: string; href: string | null };

export function runOf(
  automationId: string | null,
  automation: { id: string; name: string } | null,
  loaded: boolean,
): RunOf {
  if (automation !== null) {
    return { name: automation.name, href: automationHref(automation.id) };
  }
  return {
    name:
      automationId === null || loaded
        ? "a deleted automation"
        : "an automation",
    href: null,
  };
}

// whether a run is one of its automation's open alert: marked, and
// ended at or after the alert opened, so its foot offers Dismiss
export function inOpenAlert(
  session: Pick<FeedRow["session"], "attention" | "status" | "lastActivityAt">,
  alert: AutomationAlert | null,
): boolean {
  return (
    alert !== null &&
    session.status !== "running" &&
    needsAttention(session) &&
    session.lastActivityAt >= alert.since
  );
}

// the foot's state: the main part, which a phone always shows whole,
// and the rest, which waits for a wide screen. A done row's line is
// the answer's first line, which the transcript above already shows,
// so it says how long it took, then what it cost; a running one keeps
// its clock, then its tool calls; any other is split at its first dot
export type FootState = { main: string; more: string | null };

export function footState(row: FeedRow, now: number): FootState {
  const { session, send } = row;
  if (session.status === "running") {
    const calls = send?.toolCalls ?? 0;
    return {
      main: `working · ${whenText(row, now)}`,
      more:
        calls === 0 ? null : `${calls} tool ${calls === 1 ? "call" : "calls"}`,
    };
  }
  if (session.status === "done") {
    const took = durationOf(row, now);
    return {
      main: took === null ? "done" : `done in ${durationText(took)}`,
      more:
        send === null || send.tokens === 0
          ? null
          : `${count(send.tokens)} tokens`,
    };
  }
  const text = stateLine(row).text;
  const at = text.indexOf(" · ");
  return at < 0
    ? { main: text, more: null }
    : { main: text.slice(0, at), more: text.slice(at + 3) };
}
