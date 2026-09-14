// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the Automations tab says and checks without a DOM: a schedule
// in words for the shapes people write most, the row's meta line, who
// may change a row, and the form's fields to a request. The server
// parses the schedule and the zone; the words here only read them, and
// the expression itself stands in for any shape they do not know.

import type { SaveAutomationRequest } from "../../../shared/api/automations.ts";
import type { AutomationSummary } from "../../../shared/contracts/automation.ts";
import type { ProjectKind, Role } from "../../../shared/words.ts";
import { ago, elapsed, until } from "../../lib/format.ts";

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const NICKNAMES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const whole = (field: string, max: number): number | null => {
  if (!/^\d{1,2}$/.test(field)) return null;
  const n = Number(field);
  return n <= max ? n : null;
};

const day = (field: string): number | null => {
  const named = DAY_NAMES.indexOf(field.toUpperCase());
  if (named !== -1) return named;
  const n = whole(field, 7);
  return n === null ? null : n % 7;
};

const pad = (n: number) => String(n).padStart(2, "0");

const ordinal = (n: number) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

// "every weekday at 09:00", "every 15 minutes"; null for a shape the
// words do not know
export function scheduleWords(schedule: string): string | null {
  const text = schedule.trim();
  const fields = (NICKNAMES[text.toLowerCase()] ?? text).split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, dom, month, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (month !== "*") return null;
  const step = /^\*\/(\d{1,2})$/.exec(min);
  if (step && hour === "*" && dom === "*" && dow === "*") {
    const n = Number(step[1]);
    return n === 1 ? "every minute" : `every ${n} minutes`;
  }
  const m = whole(min, 59);
  if (m === null) return null;
  if (hour === "*" && dom === "*" && dow === "*") {
    return m === 0 ? "every hour" : `every hour at :${pad(m)}`;
  }
  const h = whole(hour, 23);
  if (h === null) return null;
  const at = `at ${pad(h)}:${pad(m)}`;
  if (dom === "*" && dow === "*") return `every day ${at}`;
  if (dom === "*") {
    const upper = dow.toUpperCase();
    if (upper === "MON-FRI" || upper === "1-5") return `every weekday ${at}`;
    if (upper === "SAT,SUN" || upper === "0,6" || upper === "6,0") {
      return `every weekend day ${at}`;
    }
    const d = day(dow);
    return d === null ? null : `every ${DAYS[d]} ${at}`;
  }
  if (dow === "*") {
    const d = whole(dom, 31);
    return d === null || d === 0
      ? null
      : `on the ${ordinal(d)} of each month ${at}`;
  }
  return null;
}

// the schedule as the row says it: the words, or the expression, then
// the zone
export function scheduleLine(schedule: string, tz: string): string {
  return `${scheduleWords(schedule) ?? schedule} ${tz}`;
}

// what the last event and the last run come to, in a few words
export function lastLine(a: AutomationSummary, now: number): string | null {
  if (a.lastRunStatus === "running") return "running";
  if (a.lastEventAt === null) return null;
  if (a.lastEventOutcome === "skipped") {
    return `skipped ${ago(a.lastEventAt, now)}`;
  }
  if (a.lastRunStatus === null) return null;
  return `last run ${a.lastRunStatus} ${ago(a.lastEventAt, now)}`;
}

// "every weekday at 09:00 Europe/Bucharest · next in 4h · last run
// done 2d ago"
export function metaLine(a: AutomationSummary, now: number): string {
  const when =
    a.suspendedAt !== null
      ? "suspended"
      : a.nextAt !== null
        ? `next ${until(a.nextAt, now)}`
        : null;
  return [scheduleLine(a.schedule, a.tz), when, lastLine(a, now)]
    .filter((s) => s !== null)
    .join(" · ");
}

// a skipped event's reason, and a fire that ran a minute or more past
// the one that was meant, for the open row
export function eventNote(a: AutomationSummary, now: number): string | null {
  if (a.lastEventAt === null) return null;
  if (a.lastEventOutcome === "skipped") {
    const why = a.lastEventReason ?? "no reason given";
    return `Skipped ${ago(a.lastEventAt, now)}: ${why}`;
  }
  if (
    a.lastEventSource === "schedule" &&
    a.lastEventDueAt !== null &&
    a.lastEventAt - a.lastEventDueAt >= 60_000
  ) {
    return `The last run started ${elapsed(a.lastEventAt - a.lastEventDueAt)} late`;
  }
  return null;
}

// the owner edits and deletes; in a team project an admin does too
export function canChange(
  a: Pick<AutomationSummary, "ownerId">,
  user: { id: string; role: Role } | null,
  kind: ProjectKind,
): boolean {
  if (user === null) return false;
  return a.ownerId === user.id || (kind === "team" && user.role === "admin");
}

export type Draft = {
  name: string;
  agentId: string;
  instructions: string;
  schedule: string;
  tz: string;
  // minutes as typed; empty for the limit's value
  deadline: string;
  // days as typed
  retention: string;
};

export const DEFAULT_SCHEDULE = "0 9 * * MON-FRI";

export function draftOf(
  a: AutomationSummary | null,
  agentId: string,
  tz: string,
): Draft {
  if (a === null) {
    return {
      name: "",
      agentId,
      instructions: "",
      schedule: DEFAULT_SCHEDULE,
      tz,
      deadline: "",
      retention: "30",
    };
  }
  return {
    name: a.name,
    agentId: a.agentId,
    instructions: a.instructions,
    schedule: a.schedule,
    tz: a.tz,
    deadline: a.deadlineMs === null ? "" : String(a.deadlineMs / 60_000),
    retention: String(a.retentionDays),
  };
}

// the body a save sends, or the first problem. Only emptiness and the
// numbers' shape are checked here; every rule is the server's
export function requestOf(
  d: Draft,
): { body: SaveAutomationRequest } | { problem: string } {
  const name = d.name.trim();
  const instructions = d.instructions.trim();
  const schedule = d.schedule.trim();
  const tz = d.tz.trim();
  if (name === "") return { problem: "Name is empty" };
  if (d.agentId === "") return { problem: "Pick an agent" };
  if (instructions === "") return { problem: "Instructions are empty" };
  if (schedule === "") return { problem: "Schedule is empty" };
  if (tz === "") return { problem: "Zone is empty" };
  const minutes = d.deadline.trim();
  if (minutes !== "" && !/^\d+$/.test(minutes)) {
    return { problem: "Deadline needs whole minutes" };
  }
  const days = d.retention.trim();
  if (!/^\d+$/.test(days)) return { problem: "Keep runs needs whole days" };
  return {
    body: {
      name,
      agentId: d.agentId,
      instructions,
      schedule,
      tz,
      deadlineMs: minutes === "" ? null : Number(minutes) * 60_000,
      retentionDays: Number(days),
    },
  };
}

// whether the draft differs from the row
export function dirtyOf(d: Draft, a: AutomationSummary | null): boolean {
  if (a === null) return true;
  const base = draftOf(a, a.agentId, a.tz);
  return (Object.keys(base) as (keyof Draft)[]).some(
    (k) => d[k].trim() !== base[k].trim(),
  );
}
