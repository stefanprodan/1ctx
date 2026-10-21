// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A channel's pages without a DOM or a call. The server pages whole
// turns anchored on their posts: the newest page, older ones by
// `before`, and a window `around` a quoted post. The client holds the
// newest pages as one block down to `page.before`, and at most one
// older window apart from it, the gap between them named by the last
// post of the window and the first of the block. A reload of the
// newest page keeps the older pages held; only the window goes.

import type {
  Message,
  SendSummary,
  SessionDetail,
} from "../../shared/contracts/session.ts";

// the window's last post and the block's first; the posts between are
// not held
export type Gap = { after: number; before: number };

// the rows by id, in the session's order. A fetched copy replaces the
// held one unless the held one is newer: a page read at an older revision
// (stale) never replaces a row it holds, and an ended row never goes
// back to streaming
export function mergeRows(
  held: Message[],
  next: Message[],
  stale = false,
): Message[] {
  const out = new Map(held.map((row) => [row.id, row]));
  for (const row of next) {
    const old = out.get(row.id);
    const ended = old?.status !== "streaming" && row.status === "streaming";
    if (old !== undefined && (stale || ended)) continue;
    out.set(row.id, row);
  }
  return [...out.values()].sort((a, b) => a.seq - b.seq);
}

// the sends by id, on the same rule: an ended send never goes back to
// running
export function mergeSends(
  held: readonly SendSummary[] | undefined,
  next: readonly SendSummary[],
  stale = false,
): SendSummary[] {
  const out = new Map((held ?? []).map((send) => [send.id, send]));
  for (const send of next) {
    const old = out.get(send.id);
    const ended = old?.status !== "running" && send.status === "running";
    if (old !== undefined && (stale || ended)) continue;
    out.set(send.id, send);
  }
  return [...out.values()];
}

// a page read before the commit the held rows are at, as one answered
// late while a turn ended
const staleFor = (held: SessionDetail, page: SessionDetail): boolean =>
  page.session.revision < held.session.revision;

// an envelope's send joins the turns held, a newer copy over the one
// with its id, so a new turn never drops the older ones; a post's send
// is no turn
export function withSend(
  detail: SessionDetail,
  send: SendSummary | null | undefined,
): Pick<SessionDetail, "sends"> {
  if (send == null || send.kind === "post") return { sends: detail.sends };
  return { sends: mergeSends(detail.sends, [send]) };
}

// a turn's anchor: a post, or a run's posted answer, which has no user row
export const isAnchor = (row: Message): boolean =>
  row.kind === "user" || row.run !== undefined;

// the seq a row's turn is anchored on: a post's own, an agent row's
// post's when held, else its own
export function anchors(detail: SessionDetail): (row: Message) => number {
  const posts = new Map(
    detail.messages
      .filter((row) => row.kind === "user")
      .map((row) => [row.id, row.seq]),
  );
  const firsts = new Map(
    detail.sends.map((send) => [send.id, send.firstMessageId]),
  );
  return (row) => {
    if (row.kind === "user") return row.seq;
    const first = firsts.get(row.sendId);
    return (first === undefined ? undefined : posts.get(first)) ?? row.seq;
  };
}

// whether a post lies in the pages held, so the page draws it; one an
// envelope brought from above them waits for its window
export function inView(seq: number, top: number | null, gap: Gap | null) {
  if (top !== null && seq < top) return false;
  return gap === null || seq <= gap.after || seq >= gap.before;
}

// the next older page lands over the top of what is held
export function mergeOlder(
  held: SessionDetail,
  older: SessionDetail,
): SessionDetail {
  const stale = staleFor(held, older);
  return {
    ...held,
    messages: mergeRows(held.messages, older.messages, stale),
    sends: mergeSends(held.sends, older.sends, stale),
    page: { before: older.page?.before ?? null, after: null },
  };
}

// the window held apart from the block: with a gap, the one before it
// goes first, since only one is held
function dropWindow(held: SessionDetail, gap: Gap | null): SessionDetail {
  if (gap === null) return held;
  const anchor = anchors(held);
  return {
    ...held,
    messages: held.messages.filter((row) => anchor(row) >= gap.before),
    page: { before: gap.before, after: null },
  };
}

// a window around an old post: joined to the block when it reaches it,
// held apart with a gap otherwise
export function mergeAround(
  held: SessionDetail,
  window: SessionDetail,
  gap: Gap | null,
): { detail: SessionDetail; gap: Gap | null } {
  const base = dropWindow(held, gap);
  const top = base.page?.before ?? null;
  const after = window.page?.after ?? null;
  const stale = staleFor(held, window);
  const merged: SessionDetail = {
    ...base,
    messages: mergeRows(base.messages, window.messages, stale),
    sends: mergeSends(base.sends, window.sends, stale),
    page: {
      before: top === null ? null : (window.page?.before ?? null),
      after: null,
    },
  };
  const reaches = top === null || after === null || after >= top;
  return {
    detail: merged,
    gap: reaches ? null : { after, before: top },
  };
}

// the posts after the window, read around its last one, until the
// window reaches the block
export function fillGap(
  held: SessionDetail,
  window: SessionDetail,
  gap: Gap,
): { detail: SessionDetail; gap: Gap | null } {
  const after = window.page?.after ?? null;
  const stale = staleFor(held, window);
  return {
    detail: {
      ...held,
      messages: mergeRows(held.messages, window.messages, stale),
      sends: mergeSends(held.sends, window.sends, stale),
    },
    gap: after === null || after >= gap.before ? null : { ...gap, after },
  };
}

// the newest page read again after a stream gap or a cut: its turns are
// the server's, the older pages held stay, the window goes. A newest
// page that shares no row with them leaves a gap above it. An older
// turn still held as running missed its end while the frames were lost,
// so the older pages go and scrolling up reads them again
export function mergeNewest(
  held: SessionDetail,
  fresh: SessionDetail,
  gap: Gap | null,
): { detail: SessionDetail; gap: Gap | null } {
  const from = fresh.page?.before ?? null;
  if (from === null) return { detail: fresh, gap: null };
  const base = dropWindow(held, gap);
  const anchor = anchors(base);
  const ids = new Set(fresh.messages.map((row) => row.id));
  const turns = new Set(fresh.messages.map((row) => row.sendId));
  const kept = base.messages.filter(
    (row) => anchor(row) < from && !ids.has(row.id) && !turns.has(row.sendId),
  );
  const keptSends = base.sends.filter((send) => !turns.has(send.id));
  if (
    kept.length === 0 ||
    kept.some((row) => row.status === "streaming") ||
    keptSends.some((send) => send.status === "running")
  ) {
    return { detail: fresh, gap: null };
  }
  const touches = base.messages.some((row) => ids.has(row.id));
  const top = base.page?.before ?? null;
  const last = Math.max(...kept.filter(isAnchor).map((row) => row.seq));
  return {
    detail: {
      ...fresh,
      messages: mergeRows(kept, fresh.messages),
      sends: mergeSends(keptSends, fresh.sends),
      page: { before: top, after: null },
    },
    gap:
      touches || !Number.isFinite(last) ? null : { after: last, before: from },
  };
}
