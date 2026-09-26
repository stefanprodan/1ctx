// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One project's automations, the tab's list; the automation page,
// whose runs are data/runs.ts; and the schedule preview the editor and
// the page read. A write keeps the server's row; the socket's frames
// keep the list current by the revision rule, and hand the runs theirs.
// An answer is kept only for the user, the project and the turn it was
// asked for.

import { effect, signal } from "@preact/signals";
import type {
  AutomationResponse,
  AutomationsResponse,
  PatchAutomationRequest,
  SaveAutomationRequest,
  SchedulePreviewResponse,
} from "../../shared/api/automations.ts";
import type { SessionResponse, StreamRow } from "../../shared/api/sessions.ts";
import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import type { RunFilter } from "../../shared/words.ts";
import { type Failure, failure, reason } from "../lib/format.ts";
import { api } from "./api.ts";
import {
  matchesFilter,
  upsertAutomation,
  upsertRun,
} from "./automations-rows.ts";

export { matchesFilter, upsertAutomation, upsertRun };

import { Held } from "./held.ts";
import { me } from "./me.ts";
import { keyOf, loadMemory } from "./memory.ts";
import { loadProject } from "./projects.ts";
import {
  applyRun,
  applyRunEnvelope,
  closeRuns,
  dropRun,
  loadRuns,
  relabelRuns,
  runs,
} from "./runs.ts";
import { loadProjectAgents } from "./sessions.ts";
import { onSocketEvent } from "./socket.ts";
import { applyAutomationFrame } from "./stream.ts";

export const automations = signal<AutomationSummary[] | null>(null);
export const automationsError = signal<Failure | null>(null);
// the run deadline limit a row with no deadline runs under, in ms
export const runDeadlineMs = signal<number | null>(null);
// the automation page's own failure, a 404 for one gone or not ours
export const automationError = signal<Failure | null>(null);
// the project the automation on screen was found in, so the page tells
// a row still loading from one deleted since
export const automationProject = signal<{
  id: string;
  projectId: string;
} | null>(null);
// a schedule read back by the server: its next fires, or its refusal;
// fires and problem are both null while it is asked
export type Preview = {
  key: string;
  fires: number[] | null;
  problem: string | null;
};
export const preview = signal<Preview | null>(null);

let owner: string | null = null;
let projectFor: string | null = null;
// the lists of the projects seen before, drawn at once on the way back
// while they load again
const kept = new Held<{
  list: AutomationSummary[];
  deadline: number | null;
}>();
let listTurn = 0;
let pageTurn = 0;
// deleted automations: a row read before its delete never joins again
const gone = new Set<string>();
let previewTurn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  projectFor = null;
  kept.clear();
  listTurn++;
  automations.value = null;
  automationsError.value = null;
  runDeadlineMs.value = null;
  automationError.value = null;
  automationProject.value = null;
  preview.value = null;
});

// how many automations the project has, null while its list is not the
// one held; the list goes to null whenever the project changes, so a
// reader of this follows the signal
export function automationCount(projectId: string): number | null {
  const list = automations.value;
  return list === null || projectFor !== projectId ? null : list.length;
}

const path = (id: string) => `/api/automations/${encodeURIComponent(id)}`;

// the stream row's label for a run of a held automation
const labelOf = (id: string): StreamRow["automation"] => {
  const row = automations.value?.find((a) => a.id === id);
  return row === undefined ? null : { id: row.id, name: row.name };
};

export async function loadAutomations(projectId: string): Promise<void> {
  const forUser = owner;
  const turn = ++listTurn;
  if (projectFor !== projectId) {
    if (projectFor !== null && automations.value !== null) {
      kept.set(projectFor, {
        list: automations.value,
        deadline: runDeadlineMs.value,
      });
    }
    const held = kept.get(projectId);
    automations.value = held?.list ?? null;
    runDeadlineMs.value = held?.deadline ?? null;
    closeRuns();
  }
  projectFor = projectId;
  automationsError.value = null;
  try {
    const body = await api<AutomationsResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/automations`,
    );
    if (owner === forUser && listTurn === turn) {
      runDeadlineMs.value = body.runDeadlineMs;
      // a frame that landed while the answer was in flight keeps its word
      const held = automations.value ?? [];
      automations.value = body.automations.reduce(
        (list, row) => upsertAutomation(list, row),
        held.filter((a) => body.automations.some((b) => b.id === a.id)),
      );
    }
  } catch (err) {
    if (owner === forUser && listTurn === turn) {
      automationsError.value = failure(err);
    }
  }
}

// the automation page and its editor: the row says which project it is
// in, and that project's list, its page, its agents and the runs load
// from there; the runs only for the page, under its filter
export async function loadAutomationPage(
  id: string,
  filter: RunFilter | null | undefined,
): Promise<void> {
  const forUser = owner;
  const turn = ++pageTurn;
  automationError.value = null;
  if (filter !== undefined && runs.value?.id !== id) closeRuns();
  let row: AutomationSummary;
  try {
    ({ automation: row } = await api<AutomationResponse>(path(id)));
  } catch (err) {
    if (owner === forUser && pageTurn === turn) {
      automationError.value = failure(err);
    }
    return;
  }
  if (owner !== forUser || pageTurn !== turn) return;
  automationProject.value = { id, projectId: row.projectId };
  if (filter === undefined) closeRuns();
  await Promise.all([
    loadAutomations(row.projectId),
    loadProject(row.projectId),
    loadProjectAgents(row.projectId),
    filter === undefined ? undefined : loadRuns(id, filter),
    loadMemory(keyOf(row.projectId, id)),
  ]);
  // a list answered before the row was made lacks it; the row just read
  // joins by the revision rule
  if (
    owner === forUser &&
    pageTurn === turn &&
    projectFor === row.projectId &&
    automations.value !== null &&
    !gone.has(row.id) &&
    !automations.value.some((a) => a.id === row.id)
  ) {
    automations.value = upsertAutomation(automations.value, row);
  }
}

export const previewKey = (projectId: string, schedule: string, tz: string) =>
  `${projectId}\n${schedule}\n${tz}`;

// the next fires of a schedule in a zone, as a save would read it; a
// later ask supersedes this one
export async function loadPreview(
  projectId: string,
  schedule: string,
  tz: string,
): Promise<void> {
  const forUser = owner;
  const turn = ++previewTurn;
  const key = previewKey(projectId, schedule, tz);
  if (preview.value?.key !== key) {
    preview.value = { key, fires: null, problem: null };
  }
  const query = new URLSearchParams({ schedule, tz });
  try {
    const body = await api<SchedulePreviewResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/automations/preview?${query}`,
    );
    if (owner === forUser && previewTurn === turn) {
      preview.value = { key, fires: body.fires, problem: null };
    }
  } catch (err) {
    if (owner === forUser && previewTurn === turn) {
      preview.value = { key, fires: null, problem: reason(err) };
    }
  }
}

function take(row: AutomationSummary, forUser: string | null): void {
  if (owner !== forUser || projectFor !== row.projectId) return;
  listTurn++;
  if (automations.value === null) {
    void loadAutomations(row.projectId);
    return;
  }
  automations.value = upsertAutomation(automations.value, row);
}

export async function createAutomation(
  projectId: string,
  body: SaveAutomationRequest,
): Promise<AutomationSummary> {
  const forUser = owner;
  const { automation } = await api<AutomationResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/automations`,
    "POST",
    body,
  );
  take(automation, forUser);
  return automation;
}

export async function updateAutomation(
  id: string,
  body: PatchAutomationRequest,
): Promise<AutomationSummary> {
  const forUser = owner;
  const { automation } = await api<AutomationResponse>(path(id), "PATCH", body);
  take(automation, forUser);
  return automation;
}

export async function suspendAutomation(id: string, suspend: boolean) {
  const forUser = owner;
  const { automation } = await api<AutomationResponse>(
    `${path(id)}/${suspend ? "suspend" : "resume"}`,
    "POST",
  );
  take(automation, forUser);
  return automation;
}

// the run opens at once; its row joins the runs from the answer, and
// the envelopes that follow move it
export async function runAutomation(id: string): Promise<SessionDetail> {
  const forUser = owner;
  const detail = await api<SessionResponse>(`${path(id)}/run`, "POST");
  const held = runs.value;
  if (owner === forUser && held?.id === id) {
    applyRun(held, {
      session: detail.session,
      agent: null,
      agentRetired: false,
      send: detail.send,
      last: null,
      automation: labelOf(id),
      // the one who pressed it is the one signed in
      runBy: me.value ? { id: me.value.id, username: me.value.username } : null,
      runs: null,
    });
  }
  return detail;
}

// withRuns deletes its runs with it; else they stay, their automation
// gone
export async function deleteAutomation(
  id: string,
  withRuns = false,
): Promise<void> {
  const forUser = owner;
  await api(`${path(id)}${withRuns ? "?runs=delete" : ""}`, "DELETE");
  gone.add(id);
  if (owner !== forUser) return;
  listTurn++;
  if (automations.value !== null) {
    automations.value = automations.value.filter((a) => a.id !== id);
  }
  if (runs.value?.id === id) closeRuns();
}

export function onAutomationsSocket(ev: SocketEvent): void {
  // a held list of a project off screen is loaded again when it is
  // opened rather than kept current here
  if (
    ev.type === "revoked" ||
    ((ev.type === "automation" || ev.type === "automationDeleted") &&
      ev.projectId !== projectFor)
  ) {
    kept.delete(ev.projectId);
  }
  switch (ev.type) {
    case "automation": {
      if (ev.projectId === projectFor) {
        const held = automations.value?.find((a) => a.id === ev.automation.id);
        if (held !== undefined && held.revision >= ev.automation.revision)
          break;
      }
      applyAutomationFrame(ev);
      if (ev.projectId !== projectFor) break;
      listTurn++;
      if (automations.value === null) void loadAutomations(ev.projectId);
      else {
        automations.value = upsertAutomation(automations.value, ev.automation);
      }
      relabelRuns({ id: ev.automation.id, name: ev.automation.name });
      break;
    }
    case "automationDeleted":
      gone.add(ev.automationId);
      applyAutomationFrame(ev);
      if (ev.projectId === projectFor) {
        listTurn++;
        if (automations.value === null) void loadAutomations(ev.projectId);
        else {
          automations.value = automations.value.filter(
            (a) => a.id !== ev.automationId,
          );
        }
        if (runs.value?.id === ev.automationId) closeRuns();
      }
      break;
    case "session":
      applyRunEnvelope(ev, labelOf);
      break;
    case "deleted":
      if (ev.projectId === projectFor) dropRun(ev.sessionId);
      break;
    case "revoked":
      if (ev.projectId === projectFor) {
        listTurn++;
        automations.value = null;
        closeRuns();
      }
      break;
    default:
      break;
  }
}

onSocketEvent(onAutomationsSocket);
