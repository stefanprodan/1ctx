// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the automation pages say and check without a DOM: the list
// row's state, the next run and the editor's fields to a request; a
// run's words are in Run.model.ts, a schedule's in Schedule.model.ts
// and what a save says in AutomationEdit.model.ts.

import type { SaveAutomationRequest } from "../../../shared/api/automations.ts";
import {
  AUTOMATION_DEFAULTS,
  OWN_MEMORY_GUIDANCE,
} from "../../../shared/automation-defaults.ts";
import {
  credentialOf,
  EMAIL,
  KNOWLEDGE,
  repoOf,
  serverOf,
  skillOf,
  VISUALIZE,
  WEB,
} from "../../../shared/capabilities.ts";
import {
  type AutomationSummary,
  ranOnce,
  WAIT_GRACE_MS,
} from "../../../shared/contracts/automation.ts";
import {
  type AttentionMode,
  DEFERRED_BY_RESTART,
} from "../../../shared/words.ts";
import { ago, elapsed, type Failure, until } from "../../lib/format.ts";
import { type AccessDraft, disabledOf, type Shown } from "./Access.model.ts";
import { fireLabel } from "./Schedule.model.ts";

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

// a once task's fire with its year: "today 09:00", "on Sun Oct 11 2026
// 09:00"
const onceAt = (fire: number, now: number, tz: string) => {
  const label = fireLabel(fire, now, tz, true, true);
  return /^to(day|morrow) /.test(label) ? label : `on ${label}`;
};

// "Next run tomorrow 09:00, in 14h", the brief's and the editor's; a
// task that runs once names its one fire's date with the year, "Runs
// once on Sun Oct 11 2026 09:00, in 3d"
export const nextRunWords = (
  fire: number,
  now: number,
  tz: string,
  once = false,
) =>
  once
    ? `Runs once ${onceAt(fire, now, tz)}, ${until(fire, now)}`
    : `Next run ${fireLabel(fire, now, tz, true)}, ${until(fire, now)}`;

// the brief's foot: "Waiting since 09:00", the day
// named when not today, or the next run and how far off it is
export function nextLine(
  a: Pick<AutomationSummary, "suspendedAt" | "nextAt" | "tz" | "once">,
  now: number,
): string {
  if (a.nextAt === null) return "";
  if (waitingSince(a, now) === null) {
    return nextRunWords(a.nextAt, now, a.tz, a.once);
  }
  const at = fireLabel(a.nextAt, now, a.tz, true);
  return `Waiting since ${at.replace(/^today /, "")}`;
}

// The page's next runs: the preview's fires still ahead. A task that
// runs once has one, and while its fire waits for a slot that fire is
// it, said as the brief says a wait, since the next occurrence never
// comes once the waiting one runs.
export function nextRunsOf(
  a: Pick<AutomationSummary, "suspendedAt" | "nextAt" | "tz" | "once">,
  fires: readonly number[],
  now: number,
): { waiting: string | null; fires: number[] } {
  const ahead = fires.filter((fire) => fire > now);
  if (!a.once) return { waiting: null, fires: ahead };
  if (waitingSince(a, now) !== null) {
    return { waiting: nextLine(a, now), fires: [] };
  }
  return { waiting: null, fires: ahead.slice(0, 1) };
}

// the row's meta: the last failure, red on its own, then running,
// waiting, suspended or the next fire
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
        ? "waiting"
        : a.nextAt !== null
          ? `next ${until(a.nextAt, now)}`
          : null;
  return { bad: failed, text: next ?? "" };
}

// "Suspended by @bogdan 2h ago"; a row suspended before the name was
// kept says only when; one whose agent was deleted stays paused until
// an edit picks another; one its run suspended "Ran once today 09:00"
export function suspendedText(
  a: Pick<
    AutomationSummary,
    | "suspendedAt"
    | "suspendedBy"
    | "agentRetired"
    | "onceFiredAt"
    | "onceRunSessionId"
    | "tz"
  >,
  now: number,
): string {
  if (a.agentRetired) return "Paused, its agent was deleted.";
  if (a.suspendedAt === null) return "";
  if (ranOnce(a)) {
    return `Ran once ${onceAt(a.suspendedAt, now, a.tz)}`;
  }
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

// a skipped or deferred event, and a run a restart deferred or that ran
// a minute or more past the fire that was meant, for the automation page
export function eventNote(a: AutomationSummary, now: number): string | null {
  if (a.lastEventAt === null) return null;
  if (a.lastEventOutcome === "skipped") {
    const why = a.lastEventReason ?? "no reason given";
    return `Skipped ${ago(a.lastEventAt, now)}: ${why}`;
  }
  if (a.lastEventOutcome === "deferred") {
    return `Deferred by a restart ${ago(a.lastEventAt, now)}`;
  }
  const deferred = a.lastEventReason === DEFERRED_BY_RESTART;
  if (
    a.lastEventSource === "schedule" &&
    a.lastEventDueAt !== null &&
    a.lastEventAt - a.lastEventDueAt >= 60_000
  ) {
    const late = `The last run started ${elapsed(a.lastEventAt - a.lastEventDueAt)} late`;
    return deferred ? `${late}, ${DEFERRED_BY_RESTART}` : late;
  }
  return deferred ? `The last run was ${DEFERRED_BY_RESTART}` : null;
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
export { OWN_MEMORY_GUIDANCE };

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
  attention: AttentionMode;
  // when a run needs attention, as typed
  attentionGuidance: string;
  rerunOnRestart: boolean;
  once: boolean;
} & AccessDraft;

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
      deadline: minutesOf(AUTOMATION_DEFAULTS.deadlineMs ?? limitMs),
      retention: String(AUTOMATION_DEFAULTS.retentionDays),
      memory: AUTOMATION_DEFAULTS.ownMemory ? "own" : "none",
      memoryGuidance: AUTOMATION_DEFAULTS.memoryGuidance,
      attention: AUTOMATION_DEFAULTS.attentionMode,
      attentionGuidance: AUTOMATION_DEFAULTS.attentionGuidance,
      rerunOnRestart: AUTOMATION_DEFAULTS.rerunOnRestart,
      once: AUTOMATION_DEFAULTS.once,
      web: true,
      visuals: true,
      knowledge: true,
      email: true,
      mcpOff: [],
      skillsOff: [],
      credentialsOff: [],
      reposOff: [],
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
    attention: a.attentionMode,
    attentionGuidance: a.attentionGuidance,
    rerunOnRestart: a.rerunOnRestart,
    once: a.once,
    web: !a.disabledCapabilities.includes(WEB),
    visuals: !a.disabledCapabilities.includes(VISUALIZE),
    knowledge: !a.disabledCapabilities.includes(KNOWLEDGE),
    email: !a.disabledCapabilities.includes(EMAIL),
    mcpOff: a.disabledCapabilities.filter((key) => serverOf(key) !== null),
    skillsOff: a.disabledCapabilities.filter((key) => skillOf(key) !== null),
    credentialsOff: a.disabledCapabilities.filter(
      (key) => credentialOf(key) !== null,
    ),
    reposOff: a.disabledCapabilities.filter((key) => repoOf(key) !== null),
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
  | "memoryGuidance"
  | "attention"
  | "attentionGuidance";

// which field a server refusal of the automation routes names; a cap on
// the project or a run still going is the form's
export function automationFieldOf(
  message: string,
): AutomationField | undefined {
  if (message.startsWith("name must be ") || message === "name is taken")
    return "name";
  if (message === "no such agent") return "agent";
  if (message.startsWith("instructions")) return "instructions";
  if (message.includes("schedule")) return "schedule";
  if (message.includes("time zone")) return "tz";
  if (message.startsWith("deadline")) return "deadline";
  if (message.startsWith("retention")) return "retention";
  if (message.startsWith("memory guidance")) return "memoryGuidance";
  if (message.startsWith("ownMemory")) return "memory";
  if (message.startsWith("attention guidance")) return "attentionGuidance";
  if (message.startsWith("attentionMode")) return "attention";
  return undefined;
}

// the body a save sends, or the first problem. Only emptiness and the
// numbers' shape are checked here; every rule is the server's.
// `shown` is what the switches list: a key for any other is not shown,
// so it is not saved
export function requestOf(
  d: Draft,
  limitMs: number,
  shown: Shown = {},
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
      attentionMode: d.attention,
      // kept while off, so turning a mode on again brings it back
      attentionGuidance: d.attentionGuidance.trim(),
      rerunOnRestart: d.rerunOnRestart,
      once: d.once,
      disabledCapabilities: disabledOf(d, shown),
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
