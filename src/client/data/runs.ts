// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The runs of the automation on screen, under its filter, with their
// tally, a page at a time. A filter change or a navigation loads the
// first page cold, dropping the pages past it; a tally refresh loads it
// warm, keeping them. A session envelope of a run moves a held run in
// place, or asks for the first page again when it changes what the
// filter and the tally hold. The automations entity hands the frames
// here. An answer is kept only for the user and the turn it was asked
// for, and a later page shares that turn.

import { effect, signal } from "@preact/signals";
import type {
  AutomationRunsResponse,
  RunTally,
} from "../../shared/api/automations.ts";
import type { StreamRow } from "../../shared/api/sessions.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import type { RunFilter } from "../../shared/words.ts";
import { failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { matchesFilter, upsertRun } from "./automations-rows.ts";
import { me } from "./me.ts";
import { mergeNextPage, refreshHead, runOrder } from "./sessions-rows.ts";
import { IDLE, type More } from "./stream.ts";

// newest first; rows and tally are null while they load. next is the
// cursor of the page after the rows, and more a later page's own state
export type Runs = {
  id: string;
  filter: RunFilter | null;
  rows: StreamRow[] | null;
  tally: RunTally | null;
  next: string | null;
  more: More;
};
export const runs = signal<Runs | null>(null);

let owner: string | null = null;
let runsTurn = 0;
// a held row under the same status leaves the tally as it stands; a new
// run, or one changing status, moves the tally, which only the server
// counts, so the runs are asked again, once per status a run is seen in
const seen = new Map<string, string>();
// the runs frames moved since the last first page was asked
const moved = new Map<string, StreamRow>();

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  closeRuns();
});

function address(id: string, filter: RunFilter | null, before: string | null) {
  const query = new URLSearchParams();
  if (filter !== null) query.set("filter", filter);
  if (before !== null) query.set("before", before);
  const search = query.toString();
  return `/api/automations/${encodeURIComponent(id)}/runs${
    search === "" ? "" : `?${search}`
  }`;
}

// a frame that moved a run while an answer was in flight keeps its
// word, by the revision rule
function replayMoved(rows: StreamRow[], filter: RunFilter | null) {
  for (const row of moved.values()) {
    rows = matchesFilter(row, filter)
      ? upsertRun(rows, row)
      : rows.filter((r) => r.session.id !== row.session.id);
  }
  return rows;
}

// the first page of the runs; warm keeps the held rows past it
export async function loadRuns(
  id: string,
  filter: RunFilter | null = null,
  warm = false,
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
      next: null,
      more: IDLE,
    };
  } else if (held.more.loading) {
    // the new turn drops the page in flight
    runs.value = { ...held, more: IDLE };
  }
  try {
    const body = await api<AutomationRunsResponse>(address(id, filter, null));
    if (owner !== forUser || runsTurn !== turn) return;
    const now = runs.value;
    const page =
      warm && now !== null && now.rows !== null
        ? refreshHead(now.rows, body, now.next, runOrder)
        : body;
    runs.value = {
      id,
      filter,
      rows: replayMoved(page.rows, filter),
      tally: body.tally,
      next: page.next,
      more: now?.more ?? IDLE,
    };
    moved.clear();
  } catch {
    if (owner !== forUser || runsTurn !== turn) return;
    const now = runs.value;
    // a warm load that fails keeps what is held
    if (warm && now !== null && now.rows !== null) return;
    runs.value = {
      id,
      filter,
      rows: [],
      tally: now?.tally ?? null,
      next: null,
      more: IDLE,
    };
  }
}

// the page after the runs held, under the runs' turn, so whatever
// starts another turn drops it. A failure keeps the rows and says so
export async function loadMoreRuns(): Promise<void> {
  const held = runs.value;
  if (held === null || held.rows === null) return;
  if (held.next === null || held.more.loading) return;
  const forUser = owner;
  const turn = runsTurn;
  runs.value = { ...held, more: { loading: true, error: null } };
  try {
    const body = await api<AutomationRunsResponse>(
      address(held.id, held.filter, held.next),
    );
    const now = runs.value;
    if (owner !== forUser || runsTurn !== turn) return;
    if (now === null || now.rows === null) return;
    runs.value = {
      ...now,
      rows: replayMoved(
        mergeNextPage(now.rows, body.rows, runOrder),
        now.filter,
      ),
      // the newest word on the tally
      tally: body.tally,
      next: body.next,
      more: IDLE,
    };
  } catch (err) {
    const now = runs.value;
    if (owner !== forUser || runsTurn !== turn || now === null) return;
    runs.value = { ...now, more: { loading: false, error: failure(err) } };
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

// a run's newest word into the held runs. The row moves at once, in or
// out of the filter, and the first page is asked again warm when the
// tally moved
export function applyRun(held: Runs, next: StreamRow): void {
  if (held.rows === null) {
    void loadRuns(held.id, held.filter, true);
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
  void loadRuns(held.id, held.filter, true);
}

// a session envelope of a held automation's run; label names the
// automation on a row not held
export function applyRunEnvelope(
  ev: Extract<SocketEvent, { type: "session" }>,
  label: (id: string) => StreamRow["automation"],
): void {
  const held = runs.value;
  if (held === null || ev.session.automationId !== held.id) return;
  if (held.rows === null) {
    void loadRuns(held.id, held.filter, true);
    return;
  }
  const mine = held.rows.find((r) => r.session.id === ev.session.id);
  applyRun(held, {
    session: ev.session,
    agent: mine?.agent ?? null,
    send: ev.send ?? mine?.send ?? null,
    last: ev.last ?? mine?.last ?? null,
    automation: mine?.automation ?? label(held.id),
    runBy: mine?.runBy ?? null,
  });
}

// a rename reaches the open runs, which carry the old label
export function relabelRuns(label: { id: string; name: string }): void {
  const open = runs.value;
  if (open?.id !== label.id || open.rows === null) return;
  runs.value = {
    ...open,
    rows: open.rows.map((r) =>
      r.automation?.name === label.name ? r : { ...r, automation: label },
    ),
  };
}

// a deleted session in the project of the runs: a run of them leaves
// the tally too, which only the server counts
export function dropRun(sessionId: string): void {
  const held = runs.value;
  if (held === null) return;
  runs.value = {
    ...held,
    rows: held.rows?.filter((r) => r.session.id !== sessionId) ?? null,
  };
  void loadRuns(held.id, held.filter, true);
}
