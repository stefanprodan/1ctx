// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the automation pages say and check without a DOM: a schedule
// in words for the shapes people write most, the list row's state, a
// run's source and duration, who may change a row, and the editor's
// fields to a request. The server parses the schedule and the zone;
// the words here only read them, and the expression itself stands in
// for any shape they do not know.

import type { SaveAutomationRequest } from "../../../shared/api/automations.ts";
import type {
  StreamRow,
  SwitchableCredential,
  SwitchableServer,
  SwitchableSkill,
} from "../../../shared/api/sessions.ts";
import {
  credentialOf,
  serverOf,
  skillOf,
  VISUALIZE,
  WEB,
} from "../../../shared/capabilities.ts";
import {
  type AutomationSummary,
  WAIT_GRACE_MS,
} from "../../../shared/contracts/automation.ts";
import type { ProjectKind, Role } from "../../../shared/words.ts";
import { ago, elapsed, type Failure, until } from "../../lib/format.ts";
import { disabledOf } from "./Access.model.ts";
import {
  daysOf,
  fieldsOf,
  fireLabel,
  pad,
  WEEK,
  whole,
} from "./Schedule.model.ts";

const ordinal = (n: number) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

// "Monday", "Monday and Friday", "Monday, Wednesday and Friday", in
// week order
const dayList = (days: number[]): string => {
  const names = WEEK.filter((d) => days.includes(d.value)).map((d) => d.name);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

// "every weekday at 09:00", "every 15 minutes"; null for a shape the
// words do not know
export function scheduleWords(schedule: string): string | null {
  const fields = fieldsOf(schedule);
  if (fields === null) return null;
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
  const m = whole(min, 0, 59);
  if (m === null) return null;
  if (hour === "*" && dom === "*" && dow === "*") {
    return m === 0 ? "every hour" : `every hour at :${pad(m)}`;
  }
  const h = whole(hour, 0, 23);
  if (h === null) return null;
  const at = `at ${pad(h)}:${pad(m)}`;
  if (dom === "*") {
    const days = daysOf(dow);
    if (days === null) return null;
    const key = days.join(",");
    if (days.length === 7) return `every day ${at}`;
    if (key === "1,2,3,4,5") return `every weekday ${at}`;
    if (key === "0,6") return `every weekend day ${at}`;
    return `every ${dayList(days)} ${at}`;
  }
  if (dow === "*") {
    const d = whole(dom, 0, 31);
    return d === null || d === 0
      ? null
      : `on the ${ordinal(d)} of each month ${at}`;
  }
  return null;
}

// the words with a capital, for a line of their own
export function scheduleTitle(schedule: string): string {
  const words = scheduleWords(schedule);
  return words === null
    ? schedule
    : `${words[0].toUpperCase()}${words.slice(1)}`;
}

// a fire the server left due waits for a run slot
export function waitingSince(
  a: Pick<AutomationSummary, "suspendedAt" | "nextAt">,
  now: number,
): number | null {
  return a.suspendedAt === null &&
    a.nextAt !== null &&
    a.nextAt <= now - WAIT_GRACE_MS
    ? a.nextAt
    : null;
}

// "Next run tomorrow 09:00, in 14h", the brief's and the editor's
export const nextRunWords = (fire: number, now: number, tz: string) =>
  `Next run ${fireLabel(fire, now, tz, true)}, ${until(fire, now)}`;

// the brief's foot: "Waiting for a free slot since 09:00", the day
// named when not today, or the next run and how far off it is
export function nextLine(
  a: Pick<AutomationSummary, "suspendedAt" | "nextAt" | "tz">,
  now: number,
): string {
  if (a.nextAt === null) return "";
  if (waitingSince(a, now) === null) return nextRunWords(a.nextAt, now, a.tz);
  const at = fireLabel(a.nextAt, now, a.tz, true);
  return `Waiting for a free slot since ${at.replace(/^today /, "")}`;
}

// the row's meta: the last failure, red on its own, then running,
// waiting for a slot, suspended or the next fire
export function rowState(
  a: AutomationSummary,
  now: number,
): { bad: string | null; text: string } {
  if (a.lastRunStatus === "running") return { bad: null, text: "running" };
  const failed =
    a.lastRunStatus === "failed" && a.lastEventAt !== null
      ? `failed ${ago(a.lastEventAt, now)}`
      : null;
  const next = a.agentRetired
    ? "paused"
    : a.suspendedAt !== null
      ? "suspended"
      : waitingSince(a, now) !== null
        ? "waiting for a slot"
        : a.nextAt !== null
          ? `next ${until(a.nextAt, now)}`
          : null;
  return { bad: failed, text: next ?? "" };
}

// "Suspended by @bogdan 2h ago"; a row suspended before the name was
// kept says only when; one whose agent was deleted stays paused until
// an edit picks another
export function suspendedText(
  a: Pick<AutomationSummary, "suspendedAt" | "suspendedBy" | "agentRetired">,
  now: number,
): string {
  if (a.agentRetired) return "Paused, its agent was deleted.";
  if (a.suspendedAt === null) return "";
  const by = a.suspendedBy === null ? "" : ` by @${a.suspendedBy.username}`;
  return `Suspended${by} ${ago(a.suspendedAt, now)}`;
}

// the editor's refusal while the pick is still the deleted agent
export function retiredPick(
  a: Pick<AutomationSummary, "agentId" | "agentName" | "agentRetired"> | null,
  agentId: string,
): string | null {
  if (a === null || !a.agentRetired || agentId !== a.agentId) return null;
  return `Its agent ${a.agentName} was deleted. Pick another to save.`;
}

// what started a run: "Scheduled", or "@bogdan" for whoever pressed Run
// now, the run icon's title; the name is the server's, so an admin
// outside the project is named too. A run from before sources were kept
// says nothing
export function sourceText(row: StreamRow): string {
  const { session } = row;
  if (session.runSource === "schedule") return "Scheduled";
  if (session.runSource !== "manual" || row.runBy === null) return "";
  return `@${row.runBy.username}`;
}

// how long the run has taken, while it runs up to now; null before its
// send is on the row
export function durationOf(row: StreamRow, now: number): number | null {
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

// a skipped event's reason, and a fire that ran a minute or more past
// the one that was meant, for the automation page
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

// The automation page and its editor: the row, the project it was found
// in, and the failure, a deleted row once the list is in without it.
export function automationPageOf<P extends { id: string }>(input: {
  id: string;
  rows: readonly AutomationSummary[] | null;
  found: { id: string; projectId: string } | null;
  project: P | null;
  agentsIn: boolean;
  failure: Failure | null;
}): {
  row: AutomationSummary | null;
  projectId: string | null;
  shown: P | null;
  error: Failure | string | null;
} {
  const row = input.rows?.find((a) => a.id === input.id) ?? null;
  const projectId = input.found?.id === input.id ? input.found.projectId : null;
  const shown =
    input.project !== null && input.project.id === projectId
      ? input.project
      : null;
  const gone =
    row === null && projectId !== null && input.rows !== null && input.agentsIn;
  const error = input.failure ?? (gone ? "This automation was deleted." : null);
  return { row, projectId, shown, error };
}

// A task keeps no memory or its own note.
type MemoryMode = "none" | "own";

export const MEMORY_MODES: { value: MemoryMode; label: string }[] = [
  { value: "none", label: "None" },
  { value: "own", label: "Own memory" },
];

// A starting prompt for What to remember, since a good one is hard to
// write from nothing. It stays domain-neutral.
export const OWN_MEMORY_GUIDANCE =
  "Keep a few topics that each hold a short list, and update them in place: what worked and what failed and why, where the information lives, what the last run found that the next one should build on, and what was already covered. Add an item to its list instead of making a topic for it, and drop the oldest items when the note is full. Leave out the answer itself, anything copied from the task, and errors that went away.";

// Picking a mode fills its empty box with the suggestion, and leaving a
// mode takes back a suggestion nobody changed, so it is never saved
// under a mode it was not written for.
export function pickMemory(d: Draft, memory: MemoryMode): Draft {
  if (memory === d.memory) return d;
  let { memoryGuidance } = d;
  if (d.memory === "own" && memoryGuidance === OWN_MEMORY_GUIDANCE) {
    memoryGuidance = "";
  }
  if (memory === "own" && memoryGuidance.trim() === "") {
    memoryGuidance = OWN_MEMORY_GUIDANCE;
  }
  return { ...d, memory, memoryGuidance };
}

const modeOf = (a: Pick<AutomationSummary, "ownMemory">): MemoryMode =>
  a.ownMemory ? "own" : "none";

export type Draft = {
  name: string;
  agentId: string;
  instructions: string;
  schedule: string;
  tz: string;
  // minutes as typed, the limit's to begin with; empty or the limit
  // itself follows the limit
  deadline: string;
  // days as typed
  retention: string;
  memory: MemoryMode;
  // what the run's own note keeps, as typed
  memoryGuidance: string;
  // its runs may reach the web, while the instance lets them
  web: boolean;
  // its runs may call visualize, while the admin's Visuals row is on
  visuals: boolean;
  // the keys of the MCP servers its runs go without
  mcpOff: string[];
  // the keys of the skills its runs go without
  skillsOff: string[];
  // the keys of the project's credentials its runs go without
  credentialsOff: string[];
};

const DEFAULT_SCHEDULE = "0 9 * * MON-FRI";

// minutes as the field shows them: whole when they are, else exact
const minutesOf = (ms: number) => String(ms / 60_000);

export function draftOf(
  a: AutomationSummary | null,
  agentId: string,
  tz: string,
  limitMs: number,
): Draft {
  if (a === null) {
    return {
      name: "",
      agentId,
      instructions: "",
      schedule: DEFAULT_SCHEDULE,
      tz,
      deadline: minutesOf(limitMs),
      retention: "30",
      memory: "own",
      memoryGuidance: OWN_MEMORY_GUIDANCE,
      web: true,
      visuals: true,
      mcpOff: [],
      skillsOff: [],
      credentialsOff: [],
    };
  }
  return {
    name: a.name,
    agentId: a.agentId,
    instructions: a.instructions,
    schedule: a.schedule,
    tz: a.tz,
    deadline: minutesOf(a.deadlineMs ?? limitMs),
    retention: String(a.retentionDays),
    memory: modeOf(a),
    memoryGuidance: a.memoryGuidance,
    web: !a.disabledCapabilities.includes(WEB),
    visuals: !a.disabledCapabilities.includes(VISUALIZE),
    mcpOff: a.disabledCapabilities.filter((key) => serverOf(key) !== null),
    skillsOff: a.disabledCapabilities.filter((key) => skillOf(key) !== null),
    credentialsOff: a.disabledCapabilities.filter(
      (key) => credentialOf(key) !== null,
    ),
  };
}

// A draft that still follows the limit moves with it. A deadline the
// user typed, or a fixed deadline on the row, keeps its own value.
export function followDeadlineLimit(
  d: Draft,
  touched: boolean,
  a: AutomationSummary | null,
  limitMs: number,
): Draft {
  if (touched || (a !== null && a.deadlineMs !== null)) return d;
  const deadline = minutesOf(limitMs);
  return d.deadline === deadline ? d : { ...d, deadline };
}

// the editor's fields, by the name each control carries
type AutomationField =
  | "name"
  | "agent"
  | "instructions"
  | "schedule"
  | "tz"
  | "deadline"
  | "retention"
  | "memory"
  | "memoryGuidance";

// which field a server refusal of the automation routes names; a cap on
// the project or a run still going is the form's
export function automationFieldOf(
  message: string,
): AutomationField | undefined {
  if (message === "invalid name" || message === "name is taken") return "name";
  if (message === "no such agent") return "agent";
  if (message.startsWith("instructions")) return "instructions";
  if (message.includes("schedule")) return "schedule";
  if (message.includes("time zone")) return "tz";
  if (message.startsWith("deadline")) return "deadline";
  if (message.startsWith("retention")) return "retention";
  if (message.startsWith("memory guidance")) return "memoryGuidance";
  if (message.startsWith("ownMemory")) return "memory";
  return undefined;
}

// the body a save sends, or the first problem. Only emptiness and the
// numbers' shape are checked here; every rule is the server's.
// `servers` and `skills` are the picked agent's and `credentials` the
// project's: a key for any other is not shown, so it is not saved
export function requestOf(
  d: Draft,
  limitMs: number,
  servers: readonly SwitchableServer[] = [],
  skills: readonly SwitchableSkill[] = [],
  credentials: readonly SwitchableCredential[] = [],
):
  | { body: SaveAutomationRequest }
  | { problem: string; field: AutomationField } {
  const name = d.name.trim();
  const instructions = d.instructions.trim();
  const schedule = d.schedule.trim();
  const tz = d.tz.trim();
  if (name === "") return { problem: "Name is empty", field: "name" };
  if (d.agentId === "") return { problem: "Pick an agent", field: "agent" };
  if (instructions === "")
    return { problem: "Instructions are empty", field: "instructions" };
  if (schedule === "")
    return { problem: "The schedule is not complete", field: "schedule" };
  if (tz === "") return { problem: "Pick a time zone", field: "tz" };
  const minutes = d.deadline.trim();
  if (minutes !== "" && !/^\d+(\.\d+)?$/.test(minutes)) {
    return { problem: "Deadline needs a number of minutes", field: "deadline" };
  }
  const ms = minutes === "" ? null : Math.round(Number(minutes) * 60_000);
  const days = d.retention.trim();
  if (!/^\d+$/.test(days)) {
    return {
      problem: "History retention needs whole days",
      field: "retention",
    };
  }
  return {
    body: {
      name,
      agentId: d.agentId,
      instructions,
      schedule,
      tz,
      // the limit's own value goes as none, so the row keeps following
      // the limit when an admin moves it
      deadlineMs: ms === limitMs ? null : ms,
      retentionDays: Number(days),
      ownMemory: d.memory === "own",
      memoryGuidance: d.memoryGuidance.trim(),
      disabledCapabilities: disabledOf(d, servers, skills, credentials),
    },
  };
}

// whether the draft differs from the row
export function dirtyOf(
  d: Draft,
  a: AutomationSummary | null,
  limitMs: number,
): boolean {
  if (a === null) return true;
  const base = draftOf(a, a.agentId, a.tz, limitMs);
  return (Object.keys(base) as (keyof Draft)[]).some((k) => {
    const left = d[k];
    const right = base[k];
    if (Array.isArray(left) && Array.isArray(right)) {
      return [...left].sort().join() !== [...right].sort().join();
    }
    return typeof left === "string" && typeof right === "string"
      ? left.trim() !== right.trim()
      : left !== right;
  });
}
