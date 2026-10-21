// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The channel on screen beyond what a chat has: its older pages, read
// as the reader nears the top, the window around a quoted post older
// than them, the gap a window leaves, and the actions on one turn,
// stop and cancel, whose answers are empty since their frames bring
// the change. A later load or a new channel drops what is in flight.

import { signal } from "@preact/signals";
import type { SessionResponse } from "../../shared/api/sessions.ts";
import type { Message, SessionDetail } from "../../shared/contracts/session.ts";
import { says } from "../lib/format.ts";
import { api } from "./api.ts";
import {
  fillGap,
  type Gap,
  inView,
  mergeAround,
  mergeNewest,
  mergeOlder,
} from "./channel-pages.ts";
import { session } from "./session-held.ts";
import { syncValues } from "./session-values.ts";

export { withSend } from "./channel-pages.ts";

// the gap of the channel on screen, its older page in flight or why it
// failed, and the post a quote asked the page to scroll to
export const channelGap = signal<Gap | null>(null);
export const olderPage = signal<{ loading: boolean; failure: string | null }>({
  loading: false,
  failure: null,
});
export const focusPost = signal<string | null>(null);

// counts the reads, so an answer for a page that moved on is dropped
let turn = 0;

// a detail answer: a channel's merged over the pages held when it is the
// one on screen; any other page starts the channel state afresh, so a
// channel's gap or failed page never reaches the next one or a chat
export function channelLoaded(
  held: SessionDetail | null,
  fresh: SessionDetail,
): SessionDetail {
  if (held === null || held.session.id !== fresh.session.id) {
    turn++;
    channelGap.value = null;
    olderPage.value = { loading: false, failure: null };
    focusPost.value = null;
    return fresh;
  }
  if (fresh.session.origin !== "channel") return fresh;
  const merged = mergeNewest(held, fresh, channelGap.value);
  channelGap.value = merged.gap;
  return merged.detail;
}

// an envelope's rows for the page held: a run's post above the pages or
// in the gap, as unlinking an old run sends, is updated when held and
// never added, so the page draws only what it holds
export function framed(held: SessionDetail, rows: Message[]): Message[] {
  if (held.session.origin !== "channel") return rows;
  const top = held.page?.before ?? null;
  const ids = new Set(held.messages.map((row) => row.id));
  return rows.filter(
    (row) =>
      row.run === undefined ||
      ids.has(row.id) ||
      inView(row.seq, top, channelGap.value),
  );
}

const read = (id: string, query: string) =>
  api<SessionResponse>(`/api/sessions/${encodeURIComponent(id)}?${query}`);

// the detail on screen still the one asked from, at the same cursor
function current(id: string, at: number): SessionDetail | null {
  const held = session.value;
  return held !== null && held.session.id === id && turn === at ? held : null;
}

function land(next: SessionDetail): void {
  session.value = next;
  syncValues(next);
}

export async function loadOlder(): Promise<void> {
  const held = session.value;
  const before = held?.page?.before ?? null;
  if (held === null || before === null || olderPage.value.loading) return;
  const at = ++turn;
  olderPage.value = { loading: true, failure: null };
  try {
    const older = await read(held.session.id, `before=${before}`);
    // no other older read starts while this one is out
    olderPage.value = { loading: false, failure: null };
    const now = current(held.session.id, at);
    if (now === null || now.page?.before !== before) return;
    land(mergeOlder(now, older));
  } catch (err) {
    const failure = current(held.session.id, at) === null ? null : says(err);
    olderPage.value = { loading: false, failure };
  }
}

// a quoted post: scrolled to when held, else its window read first
export async function showPost(post: {
  id: string;
  seq: number;
}): Promise<void> {
  const held = session.value;
  if (held === null) return;
  const top = held.page?.before ?? null;
  const shown =
    held.messages.some((row) => row.id === post.id) &&
    inView(post.seq, top, channelGap.value);
  if (shown) {
    focusPost.value = post.id;
    return;
  }
  const at = ++turn;
  // a failed read leaves the page as it was: the quote can be clicked again
  const window = await read(held.session.id, `around=${post.seq}`).catch(
    () => null,
  );
  const now = current(held.session.id, at);
  if (window === null || now === null) return;
  const merged = mergeAround(now, window, channelGap.value);
  channelGap.value = merged.gap;
  land(merged.detail);
  focusPost.value = post.id;
}

// the posts after the window, until it reaches the newest pages
export async function loadGap(): Promise<void> {
  const held = session.value;
  const gap = channelGap.value;
  if (held === null || gap === null) return;
  const at = ++turn;
  const window = await read(held.session.id, `around=${gap.after}`);
  const now = current(held.session.id, at);
  if (now === null || channelGap.value !== gap) return;
  const merged = fillGap(now, window, gap);
  channelGap.value = merged.gap;
  land(merged.detail);
}

export async function stopTurn(sessionId: string, sendId: string) {
  await api(
    `/api/sessions/${encodeURIComponent(sessionId)}/sends/${encodeURIComponent(sendId)}/stop`,
    "POST",
  );
}

export async function cancelTurn(sessionId: string, turnId: string) {
  await api(
    `/api/sessions/${encodeURIComponent(sessionId)}/pending/${encodeURIComponent(turnId)}`,
    "DELETE",
  );
}
