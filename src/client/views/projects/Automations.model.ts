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
  SwitchableServer,
} from "../../../shared/api/sessions.ts";
import { mcpKey, serverOf, WEB } from "../../../shared/capabilities.ts";
import type { AutomationSummary } from "../../../shared/contracts/automation.ts";
import type { ProjectKind, Role } from "../../../shared/words.ts";
import { ago, elapsed, until } from "../../lib/format.ts";
import { daysOf, fieldsOf, WEEK } from "./Schedule.model.ts";

const whole = (field: string, max: number): number | null => {
  if (!/^\d{1,2}$/.test(field)) return null;
  const n = Number(field);
  return n <= max ? n : null;
};

const pad = (n: number) => String(n).padStart(2, "0");

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
  const m = whole(min, 59);
  if (m === null) return null;
  if (hour === "*" && dom === "*" && dow === "*") {
    return m === 0 ? "every hour" : `every hour at :${pad(m)}`;
  }
  const h = whole(hour, 23);
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
    const d = whole(dom, 31);
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

// a list row's state at its right: running, suspended, or the next
// fire, after a failed last run
// the row's meta: the last failure, red on its own, then the next fire
export function rowState(
  a: AutomationSummary,
  now: number,
): { bad: string | null; text: string } {
  if (a.lastRunStatus === "running") return { bad: null, text: "running" };
  const failed =
    a.lastRunStatus === "failed" && a.lastEventAt !== null
      ? `failed ${ago(a.lastEventAt, now)}`
      : null;
  const next =
    a.suspendedAt !== null
      ? "suspended"
      : a.nextAt !== null
        ? `next ${until(a.nextAt, now)}`
        : null;
  return { bad: failed, text: next ?? "" };
}

// "Suspended by @bogdan 2h ago"; a row suspended before the name was
// kept says only when
export function suspendedText(
  a: Pick<AutomationSummary, "suspendedAt" | "suspendedBy">,
  now: number,
): string {
  if (a.suspendedAt === null) return "";
  const by = a.suspendedBy === null ? "" : ` by @${a.suspendedBy.username}`;
  return `Suspended${by} ${ago(a.suspendedAt, now)}`;
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

// A task keeps no memory, its own note, or the project's note from the
// chats it reads, never both notes.
export type MemoryMode = "none" | "own" | "project";

export const MEMORY_MODES: { value: MemoryMode; label: string }[] = [
  { value: "none", label: "None" },
  { value: "own", label: "Own memory" },
  { value: "project", label: "Project memory" },
];

// A starting prompt for each memory mode, since a good one is hard to
// write from nothing: own memory's goes in What to remember, project
// memory's is the task itself. Both stay domain-neutral.
export const OWN_MEMORY_GUIDANCE =
  "Keep a few topics that each hold a short list, and update them in place: what worked and what failed and why, where the information lives, what the last run found that the next one should build on, and what was already covered. Add an item to its list instead of making a topic for it, and drop the oldest items when the note is full. Leave out the answer itself, anything copied from the task, and errors that went away.";

export const PROJECT_MEMORY_TASK =
  "Read the chats you have not read. Keep facts that later chats in this project need: the systems, services and tools people work with and how they are set up, decisions that were made, and how people here want answers. Write each as a short fact, not an instruction, under a topic that says what it is about, and update a topic that exists instead of adding one. Leave out one-off questions, work in progress, fixes the chat did not confirm, and anything that will be stale within a week. If a chat has nothing worth keeping, record nothing.";

// Picking a mode fills its empty box with the suggestion, and leaving a
// mode takes back a suggestion nobody changed, so it is never saved
// under a mode it was not written for.
export function pickMemory(d: Draft, memory: MemoryMode): Draft {
  if (memory === d.memory) return d;
  let { instructions, memoryGuidance } = d;
  if (d.memory === "own" && memoryGuidance === OWN_MEMORY_GUIDANCE) {
    memoryGuidance = "";
  }
  if (d.memory === "project" && instructions === PROJECT_MEMORY_TASK) {
    instructions = "";
  }
  if (memory === "own" && memoryGuidance.trim() === "") {
    memoryGuidance = OWN_MEMORY_GUIDANCE;
  }
  if (memory === "project" && instructions.trim() === "") {
    instructions = PROJECT_MEMORY_TASK;
  }
  return { ...d, memory, instructions, memoryGuidance };
}

const modeOf = (a: Pick<AutomationSummary, "projectMemory" | "ownMemory">) =>
  a.ownMemory ? "own" : a.projectMemory ? "project" : "none";

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
  // the keys of the MCP servers its runs go without
  mcpOff: string[];
};

export const DEFAULT_SCHEDULE = "0 9 * * MON-FRI";

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
      mcpOff: [],
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
    mcpOff: a.disabledCapabilities.filter((key) => serverOf(key) !== null),
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

// the body a save sends, or the first problem. Only emptiness and the
// numbers' shape are checked here; every rule is the server's
// the editor's fields, by the name each control carries
export type AutomationField =
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
  if (/^(ownMemory|projectMemory)/.test(message)) return "memory";
  return undefined;
}

// `servers` are the picked agent's: a key for any other server is not
// shown, so it is not saved
export function requestOf(
  d: Draft,
  limitMs: number,
  servers: readonly SwitchableServer[] = [],
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
      projectMemory: d.memory === "project",
      ownMemory: d.memory === "own",
      memoryGuidance: d.memoryGuidance.trim(),
      disabledCapabilities: [
        ...(d.web ? [] : [WEB]),
        ...servers
          .map((server) => mcpKey(server.id))
          .filter((key) => d.mcpOff.includes(key)),
      ].sort(),
    },
  };
}

// what the row keeps its runs from, for the page's aside: the names of
// its agent's servers that are off, in name order
export function accessOf(
  a: Pick<AutomationSummary, "disabledCapabilities">,
  servers: readonly SwitchableServer[],
): { web: boolean; mcpOff: string[] } {
  return {
    web: !a.disabledCapabilities.includes(WEB),
    mcpOff: servers
      .filter((server) => a.disabledCapabilities.includes(mcpKey(server.id)))
      .map((server) => server.name)
      .sort(),
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

// the viewer's zone, where a new automation starts
export const browserZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;
