// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The stream's rows for one filter at a time: Home's, every project
// the user may see with a query, or one project's. The rows come from
// the route; the socket keeps them current through the sessions
// entity, which hands the frames here. An answer is kept only for the
// user and the turn it was asked for, as every entity does. The rows
// of the filters seen before are held, so going back to one draws its
// rows at once while they load again.

import { effect, signal } from "@preact/signals";
import type { SessionsResponse, StreamRow } from "../../shared/api/sessions.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import type { SessionOrigin } from "../../shared/words.ts";
import { api } from "./api.ts";
import { Held } from "./held.ts";
import { me } from "./me.ts";
import { ordered } from "./sessions-rows.ts";

export const list = signal<StreamRow[] | null>(null);
// origin narrows the rows to chats or to runs; null lists both
export type ListFilter = {
  project: string | null;
  q: string;
  origin?: SessionOrigin | null;
};

let owner: string | null = null;
let listFor: Required<ListFilter> & { turn: number } = {
  project: "",
  q: "",
  origin: null,
  turn: 0,
};
const kept = new Held<StreamRow[]>();

const keyOf = (f: ListFilter) =>
  JSON.stringify([f.project, f.q, f.origin ?? null]);

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  listFor = { project: "", q: "", origin: null, turn: listFor.turn + 1 };
  list.value = null;
  kept.clear();
});

const sameFilter = (a: ListFilter, b: ListFilter) =>
  a.project === b.project &&
  a.q === b.q &&
  (a.origin ?? null) === (b.origin ?? null);

// whether the filter on screen would list a row of that project, and
// of that origin when one is given
const covers = (projectId: string, origin?: SessionOrigin) =>
  (listFor.project === null || listFor.project === projectId) &&
  (origin === undefined ||
    listFor.origin === null ||
    listFor.origin === origin);

// an answer over the rows held: a held row that moved past the
// answer's copy while it was in flight keeps its newer word
function merge(held: StreamRow[] | null, answer: StreamRow[]): StreamRow[] {
  if (held === null) return ordered(answer);
  const newer = new Map(held.map((row) => [row.session.id, row]));
  return ordered(
    answer.map((row) => {
      const mine = newer.get(row.session.id);
      return mine !== undefined && mine.session.revision > row.session.revision
        ? mine
        : row;
    }),
  );
}

// the rows for a filter; a different filter puts the rows on screen
// away and shows the ones held for it, or none, so a page never shows
// another filter's list while its own loads
export async function loadList(filter: ListFilter): Promise<void> {
  const turn = listFor.turn + 1;
  if (!sameFilter(listFor, filter)) {
    if (list.value !== null) kept.set(keyOf(listFor), list.value);
    list.value = kept.get(keyOf(filter)) ?? null;
  }
  listFor = { ...filter, origin: filter.origin ?? null, turn };
  const params = new URLSearchParams();
  if (filter.project !== null) params.set("project", filter.project);
  if (filter.q !== "") params.set("q", filter.q);
  if (filter.origin) params.set("origin", filter.origin);
  const search = params.toString();
  try {
    const body = await api<SessionsResponse>(
      `/api/sessions${search === "" ? "" : `?${search}`}`,
    );
    if (listFor.turn === turn) list.value = merge(list.value, body.rows);
  } catch {
    if (listFor.turn === turn) list.value = null;
  }
}

// the list loaded again for the filter on screen
function reload(): Promise<void> {
  return loadList({
    project: listFor.project,
    q: listFor.q,
    origin: listFor.origin,
  });
}

// the row goes, and the list is loaded again when the filter covers
// the project, since an answer in flight may still hold the row
export function dropRow(sessionId: string, projectId: string): void {
  kept.update((rows) => rows.filter((row) => row.session.id !== sessionId));
  const rows = list.value;
  if (rows !== null) {
    list.value = rows.filter((row) => row.session.id !== sessionId);
  }
  if (covers(projectId)) void reload();
}

// the project may no longer be seen: its rows go, the whole list when
// it was the project's own, and an answer in flight goes with them
// since it may still hold rows of that project
export function revokeRows(projectId: string): void {
  kept.update((rows, key) =>
    JSON.parse(key)[0] === projectId
      ? null
      : rows.filter((row) => row.session.projectId !== projectId),
  );
  const rows = list.value;
  listFor = { ...listFor, turn: listFor.turn + 1 };
  if (listFor.project === projectId) list.value = null;
  else if (listFor.project === null) {
    if (rows !== null) {
      list.value = rows.filter((row) => row.session.projectId !== projectId);
    }
    void reload();
  }
}

// the list's copy of the row: the summary and the send are replaced,
// the last line only when the envelope carries one. A row not held
// is not guessed from the envelope, whose send and last may mean
// unchanged: the list is loaded again when the filter would list it,
// which is its project and no query, since the server's search is
// not reasoned about here
export function applyAutomationFrame(
  ev: Extract<SocketEvent, { type: "automation" | "automationDeleted" }>,
): void {
  const rows = list.value;
  if (rows === null || !covers(ev.projectId)) return;
  const id = ev.type === "automation" ? ev.automation.id : ev.automationId;
  const label =
    ev.type === "automation"
      ? { id: ev.automation.id, name: ev.automation.name }
      : null;
  let changed = false;
  const next = rows.map((row) => {
    if (row.session.origin !== "automation") return row;
    if ((row.automation?.id ?? row.session.automationId) !== id) return row;
    if (
      row.automation?.id === label?.id &&
      row.automation?.name === label?.name
    ) {
      return row;
    }
    changed = true;
    return { ...row, automation: label };
  });
  if (changed) list.value = next;
}

export function applyEnvelope(
  ev: Extract<SocketEvent, { type: "session" }>,
): void {
  const rows = list.value;
  if (rows === null || !covers(ev.projectId, ev.session.origin)) return;
  const held = rows.find((row) => row.session.id === ev.session.id);
  if (held === undefined) {
    if (listFor.q === "") void reload();
    return;
  }
  if (held.session.revision >= ev.session.revision) return;
  const next: StreamRow = {
    session: ev.session,
    agent: held.agent,
    send: ev.send ?? held.send,
    last: ev.last ?? held.last,
    automation: held.automation,
    runBy: held.runBy,
  };
  list.value = ordered([
    ...rows.filter((row) => row.session.id !== ev.session.id),
    next,
  ]);
}
