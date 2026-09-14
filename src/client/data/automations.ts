// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One project's automations, the tab's list, and the runs of the row
// that is open. A write keeps the server's row; the socket's frames
// keep the list current by the revision rule, and a session envelope
// of a run keeps the open row's runs current the way the stream does.
// An answer is kept only for the user, the project and the turn it
// was asked for.

import { effect, signal } from "@preact/signals";
import type {
  AutomationResponse,
  AutomationRunsResponse,
  AutomationsResponse,
  PatchAutomationRequest,
  SaveAutomationRequest,
} from "../../shared/api/automations.ts";
import type { SessionResponse, StreamRow } from "../../shared/api/sessions.ts";
import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { reason } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";
import { onSocketEvent } from "./socket.ts";
import { applyAutomationFrame } from "./stream.ts";

export const automations = signal<AutomationSummary[] | null>(null);
export const automationsError = signal<string | null>(null);
// the open row's runs, newest first; null while they load
export const runs = signal<{ id: string; rows: StreamRow[] | null } | null>(
  null,
);

let owner: string | null = null;
let projectFor: string | null = null;
let listTurn = 0;
let runsTurn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  projectFor = null;
  listTurn++;
  runsTurn++;
  automations.value = null;
  automationsError.value = null;
  runs.value = null;
});

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

// a run's envelope into the open row's runs: a held row moves when the
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
      // a frame that landed while the answer was in flight keeps its word
      const held = automations.value ?? [];
      automations.value = body.automations.reduce(
        (list, row) => upsertAutomation(list, row),
        held.filter((a) => body.automations.some((b) => b.id === a.id)),
      );
    }
  } catch (err) {
    if (owner === forUser && listTurn === turn) {
      automationsError.value = reason(err);
    }
  }
}

export async function loadRuns(id: string): Promise<void> {
  const forUser = owner;
  const turn = ++runsTurn;
  if (runs.value?.id !== id) runs.value = { id, rows: null };
  try {
    const body = await api<AutomationRunsResponse>(`${path(id)}/runs`);
    if (owner === forUser && runsTurn === turn) {
      runs.value = { id, rows: body.rows };
    }
  } catch {
    if (owner === forUser && runsTurn === turn) runs.value = { id, rows: [] };
  }
}

export function closeRuns(): void {
  runsTurn++;
  runs.value = null;
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
    runsTurn++;
    if (held.rows === null) {
      void loadRuns(id);
    } else {
      runs.value = {
        id,
        rows: upsertRun(held.rows, {
          session: detail.session,
          send: detail.send,
          last: null,
          automation: labelOf(id),
        }),
      };
    }
  }
  return detail;
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
            id: open.id,
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
      runsTurn++;
      if (held.rows === null) {
        void loadRuns(held.id);
        break;
      }
      const mine = held.rows.find((r) => r.session.id === ev.session.id);
      runs.value = {
        id: held.id,
        rows: upsertRun(held.rows, {
          session: ev.session,
          send: ev.send ?? mine?.send ?? null,
          last: ev.last ?? mine?.last ?? null,
          automation: mine?.automation ?? labelOf(held.id),
        }),
      };
      break;
    }
    case "deleted": {
      const held = runs.value;
      if (held !== null && ev.projectId === projectFor) {
        runsTurn++;
        if (held.rows === null) void loadRuns(held.id);
        else {
          runs.value = {
            id: held.id,
            rows: held.rows.filter((r) => r.session.id !== ev.sessionId),
          };
        }
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
