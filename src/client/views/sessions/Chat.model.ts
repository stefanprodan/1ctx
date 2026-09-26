// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words of an archived chat's foot, without a DOM: why it was
// archived, then when the delete limit removes it, the date kept on
// one line. Before the detail says who and until when, as while an
// envelope's refetch is on its way, the line says only why. And the
// agents Fork offers, never a deleted one.

import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type {
  SessionAgent,
  SessionArchive,
  SessionSummary,
} from "../../../shared/contracts/session.ts";
import { dayMonth, dayMonthYear, pluralCommas } from "../../lib/format.ts";

const DAY = 86_400_000;

// no break inside the date, so a narrow foot wraps before it
const unbroken = (text: string): string => text.replaceAll(" ", "\u00a0");

export function archivedLine(
  session: Pick<SessionSummary, "archived" | "lastActivityAt">,
  archive: SessionArchive | null,
): string {
  const { archived } = session;
  if (archived === null) return "";
  // the sweep archives within the hour past the limit, so the whole
  // days between the last activity and the archive are the limit's
  const idle = Math.floor((archived.at - session.lastActivityAt) / DAY);
  const why =
    archived.reason === "agent"
      ? "Archived when its agent was deleted"
      : archived.reason === "idle"
        ? `Archived after ${pluralCommas(idle, "day", "days")} without activity`
        : archive?.by
          ? `Archived by @${archive.by.username} on ${dayMonth(archived.at)}`
          : `Archived on ${dayMonth(archived.at)}`;
  if (archive === null) return why;
  return `${why} · kept until ${unbroken(dayMonthYear(archive.keptUntil))}`;
}

// the agents a fork may pick: the project's, less any the detail says
// was deleted, which a list read before the delete may still hold
export function forkAgents(
  agents: AgentSummary[],
  named: SessionAgent[],
): AgentSummary[] {
  const gone = new Set(named.filter((a) => a.retired).map((a) => a.id));
  return agents.filter((a) => !gone.has(a.id));
}
