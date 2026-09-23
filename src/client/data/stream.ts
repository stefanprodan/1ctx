// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The stream's rows for one filter at a time: Home's, every project
// the user may see with a query, or one project's. The rows come from
// the route a page at a time; the socket keeps them current through
// the sessions entity, which hands the frames here. An answer is kept
// only for the user and the turn it was asked for, as every entity
// does. The first page of the filters seen before is held, so going
// back to one draws it at once while it loads again.
//
// A first page loads cold or warm. Cold (a navigation, the socket's
// open, a change of access) drops every row past it, so nothing missed
// while the socket was down survives in a kept tail. Warm (a row not
// held, a delete) keeps the held rows past it, which the envelopes on
// this connection kept current.

import { effect, signal } from "@preact/signals";
import type { SessionsResponse, StreamRow } from "../../shared/api/sessions.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import type { SessionOrigin } from "../../shared/words.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { Held } from "./held.ts";
import { me } from "./me.ts";
import { mergeNextPage, ordered, refreshHead } from "./sessions-rows.ts";

// a later page's own state: the rows stay whatever it does
export type More = { loading: boolean; error: Failure | null };
// next is the cursor of the page after the rows, null at the end
export type StreamList = { rows: StreamRow[]; next: string | null; more: More };

export const IDLE: More = { loading: false, error: null };

export const list = signal<StreamList | null>(null);
// origin narrows the rows to chats or to runs; null lists both
export type ListFilter = {
  project: string | null;
  q: string;
  origin?: SessionOrigin | null;
};

let owner: string | null = null;
// turn orders the first pages; cold moves on every cold load, and a
// later page lands only under the cold it was asked in
let listFor: Required<ListFilter> & { turn: number; cold: number } = {
  project: "",
  q: "",
  origin: null,
  turn: 0,
  cold: 0,
};
// the last first page's length and next, what a held filter keeps
let head: { size: number; next: string | null } = { size: 0, next: null };
// whether the last cold load landed: until it does, a warm one is cold
// too, or it would keep the tail the cold one is there to drop
let settled = true;
const kept = new Held<{ rows: StreamRow[]; next: string | null }>();

const keyOf = (f: ListFilter) =>
  JSON.stringify([f.project, f.q, f.origin ?? null]);

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  listFor = {
    project: "",
    q: "",
    origin: null,
    turn: listFor.turn + 1,
    cold: listFor.cold + 1,
  };
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

// a cold answer over the rows held: a held row that moved past the
// answer's copy while it was in flight keeps its newer word, and
// nothing past the answer stays
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

// the first page of what is on screen, as a held filter keeps it
function firstPage(rows: StreamRow[]): {
  rows: StreamRow[];
  next: string | null;
} {
  return head.next === null
    ? { rows, next: null }
    : { rows: rows.slice(0, head.size), next: head.next };
}

function address(filter: Required<ListFilter>, before: string | null): string {
  const params = new URLSearchParams();
  if (filter.project !== null) params.set("project", filter.project);
  if (filter.q !== "") params.set("q", filter.q);
  if (filter.origin) params.set("origin", filter.origin);
  if (before !== null) params.set("before", before);
  const search = params.toString();
  return `/api/sessions${search === "" ? "" : `?${search}`}`;
}

// the first page for a filter; a different filter puts the rows on
// screen away and shows the first page held for it, or none, so a page
// never shows another filter's list while its own loads
async function load(filter: ListFilter, asked: boolean): Promise<void> {
  const warm = asked && settled;
  const turn = listFor.turn + 1;
  const cold = warm ? listFor.cold : listFor.cold + 1;
  if (!sameFilter(listFor, filter)) {
    if (list.value !== null)
      kept.set(keyOf(listFor), firstPage(list.value.rows));
    const held = kept.get(keyOf(filter));
    list.value = held === undefined ? null : { ...held, more: IDLE };
    head = { size: held?.rows.length ?? 0, next: held?.next ?? null };
  } else if (!warm && list.value?.more.loading) {
    // the page in flight is not wanted past a cold load
    list.value = { ...list.value, more: IDLE };
  }
  listFor = { ...filter, origin: filter.origin ?? null, turn, cold };
  if (!warm) settled = false;
  try {
    const body = await api<SessionsResponse>(address(listFor, null));
    if (listFor.turn !== turn) return;
    const held = list.value;
    head = { size: body.rows.length, next: body.next };
    settled = true;
    list.value =
      warm && held !== null
        ? { ...refreshHead(held.rows, body, held.next), more: held.more }
        : {
            rows: merge(held?.rows ?? null, body.rows),
            next: body.next,
            more: IDLE,
          };
  } catch {
    // a warm load that fails keeps what is held
    if (listFor.turn === turn && !(warm && list.value !== null)) {
      list.value = null;
    }
  }
}

export function loadList(filter: ListFilter): Promise<void> {
  return load(filter, false);
}

// the first page again for the filter on screen, over the rows held
function refresh(): Promise<void> {
  return load(
    { project: listFor.project, q: listFor.q, origin: listFor.origin },
    true,
  );
}

// the page after the rows held; a failure keeps the rows and says so
// under them
export async function loadMore(): Promise<void> {
  const held = list.value;
  if (held === null || held.next === null || held.more.loading) return;
  const cold = listFor.cold;
  list.value = { ...held, more: { loading: true, error: null } };
  try {
    const body = await api<SessionsResponse>(address(listFor, held.next));
    const now = list.value;
    if (listFor.cold !== cold || now === null) return;
    list.value = {
      rows: mergeNextPage(now.rows, body.rows),
      next: body.next,
      more: IDLE,
    };
  } catch (err) {
    const now = list.value;
    if (listFor.cold !== cold || now === null) return;
    list.value = { ...now, more: { loading: false, error: failure(err) } };
  }
}

const without = (rows: StreamRow[], keep: (row: StreamRow) => boolean) => {
  const out = rows.filter(keep);
  return out.length === rows.length ? rows : out;
};

// the row goes, and the first page is loaded again when the filter
// covers the project, since an answer in flight may still hold the row
export function dropRow(sessionId: string, projectId: string): void {
  const keep = (row: StreamRow) => row.session.id !== sessionId;
  kept.update((held) => ({ ...held, rows: without(held.rows, keep) }));
  const held = list.value;
  if (held !== null) list.value = { ...held, rows: without(held.rows, keep) };
  if (covers(projectId)) void refresh();
}

// the project may no longer be seen: its rows go, the whole list when
// it was the project's own, and an answer in flight goes with them
// since it may still hold rows of that project. What is left loads
// cold, so no row of it stays in a tail
export function revokeRows(projectId: string): void {
  const keep = (row: StreamRow) => row.session.projectId !== projectId;
  kept.update((held, key) =>
    JSON.parse(key)[0] === projectId
      ? null
      : { ...held, rows: without(held.rows, keep) },
  );
  const held = list.value;
  listFor = { ...listFor, turn: listFor.turn + 1, cold: listFor.cold + 1 };
  if (listFor.project === projectId) list.value = null;
  else if (listFor.project === null) {
    if (held !== null) {
      list.value = { ...held, rows: without(held.rows, keep), more: IDLE };
    }
    void loadList(listFor);
  }
}

// a project that joined what the user sees brings its rows on the
// lists that cover it
export function grantRows(projectId: string): void {
  if (list.value !== null && covers(projectId)) void loadList(listFor);
}

// the list's copy of the row: the summary and the send are replaced,
// the last line only when the envelope carries one. A row not held
// is not guessed from the envelope, whose send and last may mean
// unchanged: the first page is loaded again, warm, when the filter
// would list it, a search included, since the row may come from a
// page not loaded
export function applyAutomationFrame(
  ev: Extract<SocketEvent, { type: "automation" | "automationDeleted" }>,
): void {
  const held = list.value;
  if (held === null || !covers(ev.projectId)) return;
  const id = ev.type === "automation" ? ev.automation.id : ev.automationId;
  const label =
    ev.type === "automation"
      ? { id: ev.automation.id, name: ev.automation.name }
      : null;
  let changed = false;
  const rows = held.rows.map((row) => {
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
  if (changed) list.value = { ...held, rows };
}

export function applyEnvelope(
  ev: Extract<SocketEvent, { type: "session" }>,
): void {
  const list0 = list.value;
  if (list0 === null || !covers(ev.projectId, ev.session.origin)) return;
  const held = list0.rows.find((row) => row.session.id === ev.session.id);
  if (held === undefined) {
    void refresh();
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
  list.value = {
    ...list0,
    rows: ordered([
      ...list0.rows.filter((row) => row.session.id !== ev.session.id),
      next,
    ]),
  };
}
