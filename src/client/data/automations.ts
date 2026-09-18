// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One project's automations, the tab's list; the runs of the
// automation on screen, under its filter, with their tally; and the
// schedule preview the editor and the page read. A write keeps the
// server's row; the socket's frames keep the list current by the
// revision rule, and a session envelope of a run moves a held run in
// place, or asks for the runs again when it changes what the filter
// and the tally hold. An answer is kept only for the user, the project
// and the turn it was asked for.

import { effect, signal } from "@preact/signals";
import type {
  AutomationResponse,
  AutomationRunsResponse,
  AutomationsResponse,
  PatchAutomationRequest,
  RunTally,
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
import { me } from "./me.ts";
import { keyOf, loadMemory } from "./memory.ts";
import { loadProject } from "./projects.ts";
import { loadProjectAgents } from "./sessions.ts";
import { onSocketEvent } from "./socket.ts";
import { applyAutomationFrame } from "./stream.ts";

export const automations = signal<AutomationSummary[] | null>(null);
export const automationsError = signal<Failure | null>(null);
// the run deadline limit a row with no deadline runs under, in ms
export const runDeadlineMs = signal<number | null>(null);
// the runs of the automation on screen, newest first, under its
// filter; rows and tally are null while they load
export type Runs = {
  id: string;
  filter: RunFilter | null;
  rows: StreamRow[] | null;
  tally: RunTally | null;
};
export const runs = signal<Runs | null>(null);
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
let listTurn = 0;
let runsTurn = 0;
let pageTurn = 0;
let previewTurn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  projectFor = null;
  listTurn++;
  runsTurn++;
  automations.value = null;
  automationsError.value = null;
  runDeadlineMs.value = null;
  runs.value = null;
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

const byName = (a: AutomationSummary, b: AutomationSummary) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

// the row into the list by the revision rule: a held row at or above
// the incoming revision keeps its word
export function upsertAutomation(
  list: AutomationSummary[],
  row: AutomationSummary,
): AutomationSummary[] {
  const held = list.find((a) => a.id === row.id);
  if (held !== undefined && held.revision >= row.revision) return list;
  return [...list.filter((a) => a.id !== row.id), row].sort(byName);
}

// whether a run belongs under a filter
export function matchesFilter(
  row: Pick<StreamRow, "session">,
  filter: RunFilter | null,
): boolean {
  if (filter === "failed") return row.session.status === "failed";
  if (filter === "manual") return row.session.runSource === "manual";
  return true;
}

// a run's envelope into the held runs: a held row moves when the
// revision is above its own, newest first by when it was opened
export function upsertRun(rows: StreamRow[], next: StreamRow): StreamRow[] {
  const held = rows.find((r) => r.session.id === next.session.id);
  if (held !== undefined && held.session.revision >= next.session.revision) {
    return rows;
  }
  return [...rows.filter((r) => r.session.id !== next.session.id), next].sort(
    (a, b) => b.session.createdAt - a.session.createdAt,
  );
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
    automations.value = null;
    runDeadlineMs.value = null;
    runs.value = null;
    runsTurn++;
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

export async function loadRuns(
  id: string,
  filter: RunFilter | null = null,
): Promise<void> {
  const forUser = owner;
  const turn = ++runsTurn;
  moved.clear();
  const held = runs.value;
  if (held?.id !== id || held.filter !== filter) {
    // the tally does not follow the filter, so it stays while the rows
    // of another filter load
    runs.value = {
      id,
      filter,
      rows: null,
      tally: held?.id === id ? held.tally : null,
    };
  }
  try {
    const body = await api<AutomationRunsResponse>(
      `${path(id)}/runs${filter === null ? "" : `?filter=${filter}`}`,
    );
    if (owner === forUser && runsTurn === turn) {
      // a frame that moved a run while the answer was in flight keeps
      // its word, by the revision rule
      let rows = body.rows;
      for (const row of moved.values()) {
        rows = matchesFilter(row, filter)
          ? upsertRun(rows, row)
          : rows.filter((r) => r.session.id !== row.session.id);
      }
      moved.clear();
      runs.value = { id, filter, rows, tally: body.tally };
    }
  } catch {
    if (owner === forUser && runsTurn === turn) {
      runs.value = { id, filter, rows: [], tally: runs.value?.tally ?? null };
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

// the runs of one automation go, and nothing else's: the next page's
// load may already hold its own
export function closeRunsOf(id: string): void {
  if (runs.value?.id === id) closeRuns();
}

export function closeRuns(): void {
  runsTurn++;
  runs.value = null;
  seen.clear();
  moved.clear();
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
      send: detail.send,
      last: null,
      automation: labelOf(id),
      // the one who pressed it is the one signed in
      runBy: me.value ? { id: me.value.id, username: me.value.username } : null,
    });
  }
  return detail;
}

// a run's newest word into the held runs. The row moves at once, in or
// out of the filter. A held row under the same status leaves the tally
// as it stands; a new run, or one changing status, moves the tally,
// which only the server counts, so the runs are asked again, once per
// status a run is seen in
const seen = new Map<string, string>();
// the runs frames moved since the last load started
const moved = new Map<string, StreamRow>();
function applyRun(held: Runs, next: StreamRow): void {
  if (held.rows === null) {
    void loadRuns(held.id, held.filter);
    return;
  }
  const mine = held.rows.find((r) => r.session.id === next.session.id);
  // no new turn: a load in flight still lands, and keeps this row by
  // its revision
  moved.set(next.session.id, next);
  runs.value = {
    ...held,
    rows: matchesFilter(next, held.filter)
      ? upsertRun(held.rows, next)
      : held.rows.filter((r) => r.session.id !== next.session.id),
  };
  if (mine !== undefined && mine.session.status === next.session.status) {
    return;
  }
  const word = `${held.id} ${held.filter} ${next.session.status}`;
  if (seen.get(next.session.id) === word) return;
  seen.set(next.session.id, word);
  void loadRuns(held.id, held.filter);
}

export async function deleteAutomation(id: string): Promise<void> {
  const forUser = owner;
  await api(path(id), "DELETE");
  if (owner !== forUser) return;
  listTurn++;
  if (automations.value !== null) {
    automations.value = automations.value.filter((a) => a.id !== id);
  }
  if (runs.value?.id === id) closeRuns();
}

export function onAutomationsSocket(ev: SocketEvent): void {
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
      // a rename reaches the open row's runs, which carry the old label
      {
        const open = runs.value;
        if (open?.id === ev.automation.id && open.rows !== null) {
          const label = { id: ev.automation.id, name: ev.automation.name };
          runs.value = {
            ...open,
            rows: open.rows.map((r) =>
              r.automation?.name === label.name
                ? r
                : { ...r, automation: label },
            ),
          };
        }
      }
      break;
    }
    case "automationDeleted":
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
    case "session": {
      const held = runs.value;
      if (held === null || ev.session.automationId !== held.id) break;
      if (held.rows === null) {
        void loadRuns(held.id, held.filter);
        break;
      }
      const mine = held.rows.find((r) => r.session.id === ev.session.id);
      applyRun(held, {
        session: ev.session,
        agent: mine?.agent ?? null,
        send: ev.send ?? mine?.send ?? null,
        last: ev.last ?? mine?.last ?? null,
        automation: mine?.automation ?? labelOf(held.id),
        runBy: mine?.runBy ?? null,
      });
      break;
    }
    case "deleted": {
      const held = runs.value;
      if (held !== null && ev.projectId === projectFor) {
        // a deleted run leaves the tally too, which only the server
        // counts
        runs.value = {
          ...held,
          rows: held.rows?.filter((r) => r.session.id !== ev.sessionId) ?? null,
        };
        void loadRuns(held.id, held.filter);
      }
      break;
    }
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
