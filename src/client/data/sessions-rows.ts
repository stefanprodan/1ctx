// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pure half of the sessions entity: the stream's order, the merge
// of a later page and of a first page over the held rows, an envelope
// over the stream's rows, the merge of rows an envelope carries, and
// the live map a detail seeds.

import type { EnvelopeRow, StreamRow } from "../../shared/api/sessions.ts";
import type {
  LastLine,
  Message,
  SendSummary,
  SessionDetail,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import type { SessionOrigin } from "../../shared/words.ts";
import { type Live, liveOf, liveOfSnapshot } from "../transcript/stream.ts";

// what the order reads of a row, and all a cursor names
export type Place = Pick<SessionSummary, "status" | "lastActivityAt" | "id">;

// a row's place: negative when a comes first
export type RowOrder = (a: Place, b: Place) => number;

const byId = (a: Place, b: Place) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

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

// in All an automation is one line: of two rows of one, the first in
// the order stays, since it is the newer run, with the higher count,
// since a count only moves up between loads
export function oneLine(rows: StreamRow[]): StreamRow[] {
  const lines = new Map<string, StreamRow>();
  let dropped = false;
  const out = rows.filter((row) => {
    const id = row.session.automationId;
    if (row.runs === null || id === null) return true;
    const first = lines.get(id);
    if (first === undefined) {
      lines.set(id, row);
      return true;
    }
    dropped = true;
    if (row.runs > (first.runs ?? 0))
      lines.set(id, { ...first, runs: row.runs });
    return false;
  });
  if (!dropped) return rows;
  return out.map((row) => {
    const id = row.session.automationId;
    return row.runs === null || id === null ? row : (lines.get(id) ?? row);
  });
}

// a run's envelope over its automation's line in All: a newer run takes
// the line and counts one more, the line's own run moves in place, an
// older run changes nothing (null). undefined when no line is held
export function swapRun(
  rows: StreamRow[],
  next: Pick<StreamRow, "session"> &
    Partial<Pick<StreamRow, "send" | "last">> & { row?: EnvelopeRow | null },
): StreamRow[] | null | undefined {
  const id = next.session.automationId;
  const line = rows.find(
    (row) => row.runs !== null && row.session.automationId === id,
  );
  if (id === null || line === undefined) return undefined;
  const same = line.session.id === next.session.id;
  if (same && line.session.revision >= next.session.revision) return null;
  if (!same && next.session.createdAt <= line.session.createdAt) return null;
  const row = next.row ?? null;
  const swapped: StreamRow =
    row !== null
      ? {
          ...row,
          session: next.session,
          runs: same ? line.runs : (line.runs ?? 0) + 1,
        }
      : same
        ? {
            ...line,
            session: next.session,
            send: next.send ?? line.send,
            last: next.last ?? line.last,
          }
        : {
            session: next.session,
            // the automation's agent may have changed since the line's run
            agent:
              next.session.agentId === line.session.agentId ? line.agent : null,
            agentRetired:
              next.session.agentId === line.session.agentId
                ? line.agentRetired
                : false,
            send: next.send ?? null,
            last: next.last ?? null,
            automation: line.automation,
            runBy: null,
            runs: (line.runs ?? 0) + 1,
          };
  return ordered([...rows.filter((row) => row !== line), swapped]);
}

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
  return oneLine(ordered([...rows.values()], order));
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
    rows: oneLine(ordered([...head, ...tail], order)),
    next: tail.length > 0 ? next : answer.next,
  };
}

// the place a feed cursor names, as sessions/cursor.ts on the server
// writes it: <running 0|1>.<last activity>.<id>; null for anything else
export function cursorPlace(cursor: string): Place | null {
  const [rank, at, id, ...rest] = cursor.split(".");
  if (rest.length > 0 || (rank !== "0" && rank !== "1")) return null;
  if (at === undefined || !/^(0|[1-9][0-9]*)$/.test(at)) return null;
  if (id === undefined || id === "") return null;
  return {
    status: rank === "1" ? "running" : "done",
    lastActivityAt: Number(at),
    id,
  };
}

// the server's search: the query trimmed, then a title holding it, ASCII
// letters in any case and every other character as it is, as SQLite's
// LIKE folds with % and _ escaped
const ascii = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
export const searched = (title: string, q: string) =>
  ascii(title).includes(ascii(q.trim()));

// what a session envelope tells the stream: the summary, what the
// transaction wrote, and the row as it stood after the commit, null
// when it could not be read
export type RowEnvelope = {
  session: SessionSummary;
  send: SendSummary | null;
  last?: LastLine;
  row: EnvelopeRow | null;
};

// the filter the rows were read under, past the project
export type Shown = { origin: SessionOrigin | null; q: string };

// what an envelope leaves of the rows (the same array when it says
// nothing new to them), and whether only the server can say the rest
export type Reconciled = { rows: StreamRow[]; reload: boolean };

// an envelope over the stream's rows. next is the cursor they page on,
// first the cursor of the last first page, which is all a reload can
// place. A row not held is inserted only where the server would list
// it: under the filter, holding the search, and above the cursor, since
// a later page brings one past it
export function reconcile(
  rows: StreamRow[],
  next: string | null,
  shown: Shown,
  ev: RowEnvelope,
  first: string | null = next,
): Reconciled {
  const same = (out: StreamRow[]) => ({ rows: out, reload: false });
  const { session } = ev;
  if (shown.origin !== null && shown.origin !== session.origin) {
    return same(rows);
  }
  const listed = shown.q === "" || searched(session.title, shown.q);
  const held = rows.find((row) => row.session.id === session.id);
  const newer = held !== undefined && held.session.revision < session.revision;
  // renamed off the search: the server no longer lists it. A line
  // stands for its automation's newest matching run, which may be
  // another, so the server says which
  if (newer && !listed) {
    return {
      rows: rows.filter((row) => row !== held),
      reload: held.runs !== null,
    };
  }
  // in All an automation's runs are one line, its newest matching run,
  // and only the server knows which that is when no line is held
  const grouped =
    shown.origin === null &&
    session.origin === "automation" &&
    session.automationId !== null;
  if (grouped) {
    const swapped = swapRun(rows, ev);
    if (swapped !== undefined) {
      return same(swapped !== null && listed ? swapped : rows);
    }
  }
  if (held !== undefined) {
    if (!newer) return same(rows);
    const moved: StreamRow =
      ev.row !== null
        ? { ...ev.row, session, runs: held.runs }
        : {
            ...held,
            session,
            // without the row, a null send and no last mean unchanged
            send: ev.send ?? held.send,
            last: ev.last ?? held.last,
          };
    return same(ordered([...rows.filter((row) => row !== held), moved]));
  }
  if (!listed) return same(rows);
  // past a cursor a page would bring it as it is then; a first page
  // holds nothing past its own cursor, which may sit above the paging
  // one when a warm load kept a tail
  const past = (cursor: string | null) => {
    if (cursor === null) return false;
    const edge = cursorPlace(cursor);
    return edge !== null && streamOrder(session, edge) > 0;
  };
  const unread = (cursor: string | null) =>
    cursor !== null && cursorPlace(cursor) === null;
  if (past(next)) return same(rows);
  if (ev.row === null || grouped || unread(next)) {
    return past(first) ? same(rows) : { rows, reload: true };
  }
  return same(ordered([...rows, { ...ev.row, session, runs: null }]));
}

// what changed the list while a first page was out: an envelope, or
// rows that went (a delete)
export type Change =
  | { ev: RowEnvelope }
  | { drop: (row: StreamRow) => boolean };

// the changes over an answer read before them, in the order they came,
// so it holds what they did; reload when one needs the server
export function replay(
  answer: StreamRow[],
  next: string | null,
  shown: Shown,
  changes: Change[],
): { rows: StreamRow[]; reload: boolean } {
  let rows = answer;
  let reload = false;
  for (const change of changes) {
    if ("drop" in change) {
      const kept = rows.filter((row) => !change.drop(row));
      if (kept.length !== rows.length) rows = kept;
      continue;
    }
    const out = reconcile(rows, next, shown, change.ev);
    reload ||= out.reload;
    rows = out.rows;
  }
  return { rows, reload };
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
