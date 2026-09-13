// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The stream's rows for one filter at a time: Home's, every project
// the user may see with a query, or one project's. The rows come from
// the route; the socket keeps them current through the sessions
// entity, which hands the frames here. An answer is kept only for the
// user and the turn it was asked for, as every entity does.

import { effect, signal } from "@preact/signals";
import type { SessionsResponse, StreamRow } from "../../shared/api/sessions.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";
import { ordered } from "./sessions-rows.ts";

export const list = signal<StreamRow[] | null>(null);
export type ListFilter = { project: string | null; q: string };

let owner: string | null = null;
let listFor: ListFilter & { turn: number } = { project: "", q: "", turn: 0 };

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  listFor = { project: "", q: "", turn: listFor.turn + 1 };
  list.value = null;
});

const sameFilter = (a: ListFilter, b: ListFilter) =>
  a.project === b.project && a.q === b.q;

// whether the filter on screen would list a row of that project
const covers = (projectId: string) =>
  listFor.project === null || listFor.project === projectId;

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

// the rows for a filter; a different filter drops the rows on screen
// so a page never shows another filter's list while its own loads
export async function loadList(filter: ListFilter): Promise<void> {
  const turn = listFor.turn + 1;
  if (!sameFilter(listFor, filter)) list.value = null;
  listFor = { ...filter, turn };
  const params = new URLSearchParams();
  if (filter.project !== null) params.set("project", filter.project);
  if (filter.q !== "") params.set("q", filter.q);
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
  return loadList({ project: listFor.project, q: listFor.q });
}

// the row goes, and the list is loaded again when the filter covers
// the project, since an answer in flight may still hold the row
export function dropRow(sessionId: string, projectId: string): void {
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
export function applyEnvelope(
  ev: Extract<SocketEvent, { type: "session" }>,
): void {
  const rows = list.value;
  if (rows === null || !covers(ev.projectId)) return;
  const held = rows.find((row) => row.session.id === ev.session.id);
  if (held === undefined) {
    if (listFor.q === "") void reload();
    return;
  }
  if (held.session.revision >= ev.session.revision) return;
  const next: StreamRow = {
    session: ev.session,
    send: ev.send ?? held.send,
    last: ev.last ?? held.last,
  };
  list.value = ordered([
    ...rows.filter((row) => row.session.id !== ev.session.id),
    next,
  ]);
}
