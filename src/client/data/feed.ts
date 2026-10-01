// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The feed's rows for one filter at a time: Home's, every project
// the user may see with a query, or one project's. The rows come from
// the route a page at a time; the socket keeps them current through
// the sessions entity, which hands the frames here. An answer is kept
// only for the user and the turn it was asked for, as every entity
// does. The first page of the filters seen before is held, so going
// back to one draws it at once while it loads again.
//
// A first page loads cold or warm. Cold (a navigation, the socket's
// open, a change of access) drops every row past it, so nothing missed
// while the socket was down survives in a kept tail. Warm (a row only
// the server can place) keeps the held rows past it, which the
// envelopes on this connection kept current. An envelope's row is
// inserted or moved in place without a load; the changes made while a
// first page is out are replayed over its answer, which was read before
// them. One first page is out at a time (flight.ts).

import { effect, signal } from "@preact/signals";
import type { FeedRow, SessionsResponse } from "../../shared/api/sessions.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import type { SessionOrigin } from "../../shared/words.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { Flight } from "./flight.ts";
import { Held } from "./held.ts";
import { me } from "./me.ts";
import {
  type Change,
  cursorPlace,
  feedOrder,
  mergeNextPage,
  ordered,
  reconcile,
  refreshHead,
  replay,
  type Shown,
} from "./sessions-rows.ts";

// a later page's own state: the rows stay whatever it does
export type More = { loading: boolean; error: Failure | null };
// next is the cursor of the page after the rows, null at the end
export type FeedList = { rows: FeedRow[]; next: string | null; more: More };

export const IDLE: More = { loading: false, error: null };

export const list = signal<FeedList | null>(null);
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
// whether a first page is out, so a grant during it asks again
let loading = false;
// what changed the rows since the first page out was asked, replayed
// over its answer
let changes: Change[] = [];
// moves when a row is deleted, so a later page read before it cannot
// bring the row back
let pages = 0;
// the automations' names as their frames said, each with the frame's
// number, applied only over an answer asked before the frame
const labels = new Map<string, { label: FeedRow["automation"]; at: number }>();
// the agents an automation frame said were retired; retiring is for
// good, so it holds over any answer
const retired = new Set<string>();
let frames = 0;
const kept = new Held<{ rows: FeedRow[]; next: string | null }>();

const keyOf = (f: ListFilter) =>
  JSON.stringify([f.project, f.q, f.origin ?? null]);

// the first page again for the filter on screen, over the rows held
const flight = new Flight(() =>
  load(
    { project: listFor.project, q: listFor.q, origin: listFor.origin },
    true,
  ),
);

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
  labels.clear();
  retired.clear();
  changes = [];
  flight.stop();
  loading = false;
});

// a row of an automation the frames renamed or deleted since the answer
// was read carries the frame's word, and a retired agent's row says so
function relabel(rows: FeedRow[], asked: number): FeedRow[] {
  if (labels.size === 0 && retired.size === 0) return rows;
  return rows.map((row) => {
    const out = retired.has(row.session.agentId ?? "")
      ? { ...row, agentRetired: true }
      : row;
    const id = row.automation?.id ?? row.session.automationId;
    const said = id === null ? undefined : labels.get(id);
    if (said === undefined || said.at <= asked) return out;
    const label = said.label;
    // a gone automation's runs are listed one by one
    const runs = label === null ? null : row.runs;
    return row.automation?.name === label?.name &&
      row.automation?.id === label?.id &&
      row.runs === runs
      ? out
      : { ...out, automation: label, runs };
  });
}

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

const shown = (): Shown => ({ origin: listFor.origin, q: listFor.q });

// a cold answer over the rows held: a held row that moved past the
// answer's copy while it was in flight keeps its newer word, and
// nothing past the answer stays
function merge(held: FeedRow[] | null, answer: FeedRow[]): FeedRow[] {
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

// the first page of what is on screen, as a held filter keeps it: the
// rows up to its cursor, rows inserted above it included
function firstPage(rows: FeedRow[]): {
  rows: FeedRow[];
  next: string | null;
} {
  if (head.next === null) return { rows, next: null };
  const edge = cursorPlace(head.next);
  return {
    rows:
      edge === null
        ? rows.slice(0, head.size)
        : rows.filter((row) => feedOrder(row.session, edge) <= 0),
    next: head.next,
  };
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
  loading = true;
  changes = [];
  const since = frames;
  try {
    const answer = await api<SessionsResponse>(address(listFor, null));
    if (listFor.turn !== turn) return;
    loading = false;
    const next = answer.next ?? null;
    const replayed = replay(
      relabel(answer.rows, since),
      next,
      shown(),
      changes,
    );
    changes = [];
    const body = { rows: replayed.rows, next };
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
    if (replayed.reload) flight.ask();
  } catch {
    if (listFor.turn !== turn) return;
    loading = false;
    changes = [];
    // a warm load that fails keeps what is held
    if (!(warm && list.value !== null)) list.value = null;
  }
}

export function loadList(filter: ListFilter): Promise<void> {
  return flight.run(() => load(filter, false));
}

// the page after the rows held; a failure keeps the rows and says so
// under them
export async function loadMore(): Promise<void> {
  const held = list.value;
  if (held === null || held.next === null || held.more.loading) return;
  const cold = listFor.cold;
  const page = pages;
  const asked = frames;
  list.value = { ...held, more: { loading: true, error: null } };
  try {
    const body = await api<SessionsResponse>(address(listFor, held.next));
    const now = list.value;
    if (listFor.cold !== cold || now === null) return;
    // a row deleted since the page was read may be on it: the button
    // comes back and asks again
    if (pages !== page) {
      list.value = { ...now, more: IDLE };
      return;
    }
    list.value = {
      rows: mergeNextPage(now.rows, relabel(body.rows, asked)),
      next: body.next,
      more: IDLE,
    };
  } catch (err) {
    const now = list.value;
    if (listFor.cold !== cold || now === null) return;
    if (pages !== page) {
      list.value = { ...now, more: IDLE };
      return;
    }
    list.value = { ...now, more: { loading: false, error: failure(err) } };
  }
}

const without = (rows: FeedRow[], keep: (row: FeedRow) => boolean) => {
  const out = rows.filter(keep);
  return out.length === rows.length ? rows : out;
};

// rows went: from every held list, from the rows on screen, and from
// the answer of a first page out, which may have read them before
function drop(projectId: string, gone: (row: FeedRow) => boolean): void {
  const keep = (row: FeedRow) => !gone(row);
  if (covers(projectId)) {
    pages++;
    if (loading) changes.push({ drop: gone });
  }
  kept.update((held) => ({ ...held, rows: without(held.rows, keep) }));
  const held = list.value;
  if (held !== null) list.value = { ...held, rows: without(held.rows, keep) };
}

export function dropRow(sessionId: string, projectId: string): void {
  drop(projectId, (row) => row.session.id === sessionId);
}

// an automation's runs went with it
function dropRuns(automationId: string, projectId: string): void {
  drop(
    projectId,
    (row) => (row.automation?.id ?? row.session.automationId) === automationId,
  );
}

// the project may no longer be seen: its rows go, the whole list when
// it was the project's own, and an answer in flight goes with them
// since it may still hold rows of that project. What is left loads
// cold, so no row of it stays in a tail
export function revokeRows(projectId: string): void {
  const keep = (row: FeedRow) => row.session.projectId !== projectId;
  kept.update((held, key) =>
    JSON.parse(key)[0] === projectId
      ? null
      : { ...held, rows: without(held.rows, keep) },
  );
  const held = list.value;
  // a list of another project cannot hold its rows, and keeps its load
  if (!covers(projectId)) return;
  listFor = { ...listFor, turn: listFor.turn + 1, cold: listFor.cold + 1 };
  changes = [];
  if (listFor.project === projectId) {
    list.value = null;
    loading = false;
    flight.stop();
  } else if (listFor.project === null) {
    if (held !== null) {
      list.value = { ...held, rows: without(held.rows, keep), more: IDLE };
    }
    void loadList(listFor);
  }
}

// a project that joined what the user sees brings its rows on the
// lists that cover it
export function grantRows(projectId: string): void {
  if ((list.value !== null || loading) && covers(projectId)) {
    void loadList(listFor);
  }
}

// an agent is retired for good: every row of it says so
function retire(agentId: string): void {
  retired.add(agentId);
  const held = list.value;
  if (held === null) return;
  let changed = false;
  const rows = held.rows.map((row) => {
    if (row.session.agentId !== agentId || row.agentRetired) return row;
    changed = true;
    return { ...row, agentRetired: true };
  });
  if (changed) list.value = { ...held, rows };
}

// a rename relabels the automation's rows; a delete leaves its line
// counting nothing, or takes its runs with it; a retired agent is
// retired on every row
export function applyAutomationFrame(
  ev: Extract<SocketEvent, { type: "automation" | "automationDeleted" }>,
): void {
  const id = ev.type === "automation" ? ev.automation.id : ev.automationId;
  const label =
    ev.type === "automation"
      ? { id: ev.automation.id, name: ev.automation.name }
      : null;
  labels.set(id, { label, at: ++frames });
  if (ev.type === "automation" && ev.automation.agentRetired) {
    retire(ev.automation.agentId);
  }
  // a first page in flight may hold a line of it: the relabel stops it
  // counting, but only a page asked after the delete lists its runs
  if (label === null && list.value === null && loading) {
    if (covers(ev.projectId)) void loadList(listFor);
    return;
  }
  if (ev.type === "automationDeleted" && ev.runs) {
    dropRuns(id, ev.projectId);
    return;
  }
  const held = list.value;
  if (held === null || !covers(ev.projectId)) return;
  let changed = false;
  let grouped = false;
  const rows = held.rows.map((row) => {
    if (row.session.origin !== "automation") return row;
    if ((row.automation?.id ?? row.session.automationId) !== id) return row;
    // a gone automation's runs are listed one by one: the line stops
    // counting them, and the first page brings the others
    const runs = label === null ? null : row.runs;
    grouped ||= row.runs !== runs;
    if (
      row.runs === runs &&
      row.automation?.id === label?.id &&
      row.automation?.name === label?.name
    ) {
      return row;
    }
    changed = true;
    return { ...row, automation: label, runs };
  });
  if (changed) list.value = { ...held, rows };
  if (grouped) flight.ask();
}

// the envelope over the rows on screen (sessions-rows.ts reconcile):
// a row held moves, a row the filter lists is inserted from the
// envelope's row, and only what the server alone can place asks for
// the first page again
export function applyEnvelope(
  ev: Extract<SocketEvent, { type: "session" }>,
): void {
  if (!covers(ev.projectId, ev.session.origin)) return;
  // no frame tells of every row an agent retired: any row that says so
  // retires the agent on the rows held
  if (ev.row?.agentRetired && ev.session.agentId !== null) {
    if (!retired.has(ev.session.agentId)) retire(ev.session.agentId);
  }
  if (loading) changes.push({ ev });
  const held = list.value;
  if (held === null) return;
  const out = reconcile(held.rows, held.next, shown(), ev, head.next);
  if (out.rows !== held.rows) list.value = { ...held, rows: out.rows };
  if (out.reload) flight.ask();
}
