// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pure half of the sessions entity: the stream's order, the merge
// of a later page and of a first page over the held rows, the merge of
// rows an envelope carries, and the live map a detail seeds.

import type { StreamRow } from "../../shared/api/sessions.ts";
import type {
  Message,
  SessionDetail,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import { type Live, liveOf, liveOfSnapshot } from "../transcript/stream.ts";

// a row's place: negative when a comes first
export type RowOrder = (a: SessionSummary, b: SessionSummary) => number;

const byId = (a: SessionSummary, b: SessionSummary) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// the runs' order, the server's: by last activity, newest first, then id
export const runOrder: RowOrder = (a, b) =>
  a.lastActivityAt !== b.lastActivityAt
    ? b.lastActivityAt - a.lastActivityAt
    : byId(a, b);

// the stream's order: running first, then as the runs
export const streamOrder: RowOrder = (a, b) => {
  const ra = a.status === "running" ? 1 : 0;
  const rb = b.status === "running" ? 1 : 0;
  return ra !== rb ? rb - ra : runOrder(a, b);
};

export function ordered(
  rows: StreamRow[],
  order: RowOrder = streamOrder,
): StreamRow[] {
  return [...rows].sort(({ session: a }, { session: b }) => order(a, b));
}

// of two copies of a row, the one at the higher revision
const newest = (a: StreamRow, b: StreamRow | undefined) =>
  b !== undefined && b.session.revision > a.session.revision ? b : a;

// a later page into the held rows: the union by id, the higher revision
// winning, in the order
export function mergeNextPage(
  held: StreamRow[],
  answer: StreamRow[],
  order: RowOrder = streamOrder,
): StreamRow[] {
  const rows = new Map(held.map((row) => [row.session.id, row]));
  for (const row of answer) {
    rows.set(row.session.id, newest(row, rows.get(row.session.id)));
  }
  return ordered([...rows.values()], order);
}

// a first page over the held rows, on a connection that kept them
// current: the answer is the head, a held copy at a higher revision
// keeping its word, and the held rows strictly past the answer's last
// row are the tail. next stays the held one while a tail is kept, since
// it pages past the tail; else it is the answer's
export function refreshHead(
  held: StreamRow[],
  answer: { rows: StreamRow[]; next: string | null },
  next: string | null,
  order: RowOrder = streamOrder,
): { rows: StreamRow[]; next: string | null } {
  const mine = new Map(held.map((row) => [row.session.id, row]));
  const head = answer.rows.map((row) => newest(row, mine.get(row.session.id)));
  const last = answer.rows.at(-1);
  const inHead = new Set(answer.rows.map((row) => row.session.id));
  const tail =
    answer.next === null || last === undefined
      ? []
      : held.filter(
          (row) =>
            !inHead.has(row.session.id) && order(row.session, last.session) > 0,
        );
  return {
    rows: ordered([...head, ...tail], order),
    next: tail.length > 0 ? next : answer.next,
  };
}

// the rows whose text streams: a reply, and the summary round's row
export const streams = (m: Message) =>
  m.kind === "reply" || m.kind === "summary";

// the live map from a detail: the streaming rows, the runner's
// snapshot for the one it is about. The "tools" phase has no row, so
// every streaming row starts from itself
export function liveFrom(detail: SessionDetail): Map<string, Live> {
  const map = new Map<string, Live>();
  const snap = detail.live?.phase === "reply" ? detail.live : null;
  for (const m of detail.messages) {
    if (!streams(m) || m.status !== "streaming") continue;
    map.set(
      m.id,
      snap !== null && snap.messageId === m.id
        ? liveOfSnapshot(snap, m)
        : liveOf(m),
    );
  }
  return map;
}

// the envelope's rows over the held ones, in seq order
export function upsert(rows: Message[], next: Message[]): Message[] {
  const out = rows.slice();
  for (const m of next) {
    const i = out.findIndex((x) => x.id === m.id);
    if (i === -1) out.push(m);
    else out[i] = m;
  }
  return out.sort((a, b) => a.seq - b.seq);
}
