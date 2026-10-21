// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Durable revisions win over old loads. Stream gaps refetch a snapshot
// rather than leaving a partly applied reply or visual on screen. A
// settled chat is held once seen, so going back to it draws at once
// while it loads again.

import { effect, signal } from "@preact/signals";
import type { SessionResponse } from "../../shared/api/sessions.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { navigate } from "../app/router.ts";
import { type Failure, failure } from "../lib/format.ts";
import {
  applyDelta,
  applyHtml,
  liveOf,
  liveOfSnapshot,
  restarted,
} from "../transcript/stream.ts";
import {
  applyVisual,
  dropPreviews,
  type Previews,
  reconcileVisuals,
  snapshotVisuals,
} from "../transcript/visuals.ts";
import { api } from "./api.ts";
import { channelLoaded, framed, withSend } from "./channel.ts";
import { applyEnvelope, dropRow, grantRows, revokeRows } from "./feed.ts";
import { Held } from "./held.ts";
import { me } from "./me.ts";
import { takeChildren, takeWatched } from "./session-children.ts";
import { draftsShown, markGone, onDraftSocket } from "./session-drafts.ts";
import { session } from "./session-held.ts";
import { ahead, flushLive, live, publish, stage } from "./session-live.ts";
import { onQueueSocket, queueShown } from "./session-queue.ts";
import { sending } from "./session-start.ts";
import {
  resetValues,
  retried,
  retries,
  retriesOf,
  syncValues,
} from "./session-values.ts";
import { liveFrom, streams, upsert } from "./sessions-rows.ts";
import { onSocketEvent, watch } from "./socket.ts";

export { type ListFilter, list, loadList, loadMore } from "./feed.ts";
export {
  homeProjectId,
  loadProjectAgents,
  pickHomeProject,
  projectAgentCount,
  projectAgents,
} from "./project-agents.ts";
export { setFrames } from "./session-live.ts";
export { createSession, sending, stopSession } from "./session-start.ts";
export {
  loadToolResult,
  loadVisual,
  retries,
  toolResults,
  toolVisuals,
} from "./session-values.ts";

// frames kept while the watch is being answered; past this the
// snapshot is refetched instead
export const BUFFER_MAX = 256;

export { live, session };
export const sessionError = signal<Failure | null>(null);

// A stored call keeps only a marker here. Its mounted frame keeps the paint.
export const visualPreviews = signal<Previews>(new Map());

// the stream frames, each in its send's sequence
type Frame = Extract<SocketEvent, { seq: number }>;

let owner: string | null = null;
let wanted: { id: string; turn: number } = { id: "", turn: 0 };
// the watch in flight: the frames before its answer, and the sequence
// the next frame must follow once answered
let pending: { buffer: Frame[]; overflow: boolean } | null = null;
let sequences = new Map<string, number>();
// the settled chats by id
const chatsKept = new Held<SessionDetail>();

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  wanted = { id: "", turn: wanted.turn + 1 };
  clear();
  sessionError.value = null;
  chatsKept.clear();
  sending.value = false;
  pending = null;
  sequences.clear();
});

function show(shown: SessionDetail): void {
  const detail = draftsShown(queueShown(shown), session.value);
  visualPreviews.value = snapshotVisuals(
    reconcileVisuals(visualPreviews.value, detail),
    detail,
  );
  session.value = detail;
  publish(liveFrom(detail));
  syncValues(detail);
  retries.value = retriesOf(detail.live);
  sequences = new Map(detail.live.map((send) => [send.sendId, send.seq]));
}

// a chat is held only settled: a running one would miss its frames. A
// channel never is: it is paged, read again on every visit, and its gap
// and older page state belong to the one on screen
function keep(detail: SessionDetail | null): void {
  if (detail === null) return;
  if (
    detail.session.status === "running" ||
    detail.live.length > 0 ||
    detail.session.origin === "channel"
  ) {
    chatsKept.delete(detail.session.id);
  } else chatsKept.set(detail.session.id, detail);
}

function clear(): void {
  session.value = null;
  publish(new Map());
  resetValues();
  visualPreviews.value = new Map();
}

export async function loadSession(id: string): Promise<void> {
  const turn = wanted.turn + 1;
  wanted = { id, turn };
  sessionError.value = null;
  if (session.value?.session.id !== id) {
    keep(session.value);
    clear();
    const held = chatsKept.get(id);
    if (held !== undefined) show(held);
  }
  // what is on screen before the answer: a held copy the answer always
  // replaces, unless a frame moved it while the answer was in flight
  const before = session.value;
  try {
    const detail = await api<SessionResponse>(
      `/api/sessions/${encodeURIComponent(id)}`,
    );
    if (wanted.turn !== turn) return;
    const from = detail.session.automationId;
    if (from !== null && purged.has(from)) {
      leaveRuns(from, detail.session.projectId, true);
      return;
    }
    // an envelope may have moved the session past this answer while it
    // was in flight; the rows held are then the newer ones
    const held = session.value;
    if (
      held === null ||
      held === before ||
      held.session.id !== id ||
      detail.session.revision >= held.session.revision
    ) {
      // a channel keeps the older pages it holds
      show(channelLoaded(held, detail));
    }
    // registered before the watch is sent, so a frame that arrives
    // before the answer is kept
    pending = { buffer: [], overflow: false };
    watch(id);
  } catch (err) {
    if (wanted.turn !== turn) return;
    // a held copy of a chat that is gone or no longer seen goes with it
    chatsKept.delete(id);
    if (session.value?.session.id === id) clear();
    sessionError.value = failure(err);
  }
}

// nothing of the chat left is kept, so a late frame or a deletion of
// it moves the page nowhere; with an id, nothing happens when a load of
// another chat owns the entity, as on the way to a fork
export function leaveSession(id?: string): void {
  if (id !== undefined && wanted.id !== "" && wanted.id !== id) return;
  wanted = { id: "", turn: wanted.turn + 1 };
  pending = null;
  sequences.clear();
  keep(session.value);
  clear();
  watch(null);
}

// a write's answer is the detail: applied like an envelope, so the
// socket's copy of the same commit changes nothing
export function take(detail: SessionDetail): void {
  const held = session.value;
  if (held === null || held.session.id !== detail.session.id) return;
  if (detail.session.revision <= held.session.revision) return;
  show(detail);
}

// the row goes, and the page leaves the chat on screen or loading for
// its project; an answer in flight goes with the watch or a new load,
// so the socket's frame after a local delete finds nothing
function drop(sessionId: string, projectId: string): void {
  dropRow(sessionId, projectId);
  chatsKept.delete(sessionId);
  if (wanted.id === sessionId || session.value?.session.id === sessionId) {
    leaveSession();
    navigate(`/projects/${projectId}`);
  }
}

// an automation's runs went with it, a run read before that included
const purged = new Set<string>();
function leaveRuns(automationId: string, projectId: string, read = false) {
  purged.add(automationId);
  chatsKept.update((d) => (d.session.automationId === automationId ? null : d));
  if (!read && session.value?.session.automationId !== automationId) return;
  leaveSession();
  navigate(`/projects/${projectId}`);
}

export async function deleteSession(
  id: string,
  projectId: string,
): Promise<void> {
  await api(`/api/sessions/${encodeURIComponent(id)}`, "DELETE");
  drop(id, projectId);
}

function onEnvelope(ev: Extract<SocketEvent, { type: "session" }>): void {
  applyEnvelope(ev);
  const held = session.value;
  if (held === null || held.session.id !== ev.session.id) {
    // a held chat that moved is loaded again when it is opened
    chatsKept.delete(ev.session.id);
    return;
  }
  if (ev.session.revision <= held.session.revision) {
    // a post's answer took this commit first; its frame still brings the
    // meter the server counted after it
    const meter = ev.channelContext;
    if (meter && ev.session.revision === held.session.revision) {
      session.value = { ...held, channelContext: meter };
    }
    return;
  }
  const removed = new Set(ev.removedMessageIds ?? []);
  const messages = upsert(
    held.messages.filter((message) => !removed.has(message.id)),
    framed(held, ev.messages),
  );
  const map = new Map(ahead());
  for (const id of removed) map.delete(id);
  for (const m of ev.messages) {
    if (!streams(m)) continue;
    if (m.status === "streaming") {
      if (!map.has(m.id)) map.set(m.id, liveOf(m));
    } else map.delete(m.id);
  }
  session.value = {
    ...held,
    session: ev.session,
    messages,
    send: ev.send ?? held.send,
    channelContext: ev.channelContext ?? held.channelContext,
    ...withSend(held, ev.send),
  };
  visualPreviews.value = reconcileVisuals(visualPreviews.value, session.value);
  session.value = {
    ...session.value,
    live:
      ev.session.status !== "running"
        ? []
        : session.value.live
            .filter(
              (send) =>
                ev.send?.id !== send.sendId || ev.send.status === "running",
            )
            .map((send) => ({
              ...send,
              drafts: [...visualPreviews.value.values()].filter(
                (draft) =>
                  draft.phase === "draft" && draft.sendId === send.sendId,
              ),
            })),
  };
  syncValues(session.value);
  // a lost clear frame never outlives its send
  if (ev.session.status !== "running") retries.value = new Map();
  else if (ev.send && ev.send.status !== "running") retried(ev.send.id, null);
  publish(map);
  onQueueSocket(ev);
  // who archived it and until when are the detail's alone, and so are
  // the messages of a turn too large for the envelope
  if (ev.messagesCut || (!held.session.archived && ev.session.archived)) {
    refetch();
  }
}

// one detail answers a gap, an overflow, a frame ahead of the buffer
function refetch(): void {
  const held = session.value;
  if (held !== null) void loadSession(held.session.id);
}

function applyFrame(frame: Frame): boolean {
  const held = session.value;
  if (held === null || held.session.id !== frame.sessionId) return true;
  const seq = sequences.get(frame.sendId) ?? 0;
  if (frame.seq !== seq + 1) return false;
  sequences.set(frame.sendId, frame.seq);
  if (frame.type === "retry") {
    retried(frame.sendId, frame.retry);
    return true;
  }
  if (frame.type === "restart") {
    visualPreviews.value = dropPreviews(visualPreviews.value, frame.messageId);
    if (ahead().has(frame.messageId)) stage(frame.messageId, restarted());
    return true;
  }
  if (frame.type === "visual") {
    const row = held.messages.find((row) => row.id === frame.messageId);
    if (!row || row.sendId !== frame.sendId) return false;
    if (row.status !== "streaming") return true;
    const result = applyVisual(visualPreviews.value, frame);
    if (result.gap) return false;
    visualPreviews.value = result.previews;
    const snapshot = held.live.find((send) => send.sendId === frame.sendId) ?? {
      phase: "reply" as const,
      sendId: frame.sendId,
      messageId: row.id,
      ...liveOf(row),
      seq: frame.seq,
    };
    session.value = {
      ...held,
      live: [
        ...held.live.filter((send) => send.sendId !== frame.sendId),
        {
          ...snapshot,
          seq: frame.seq,
          drafts: [...result.previews.values()].filter(
            (draft) => draft.sendId === frame.sendId && draft.phase === "draft",
          ),
        },
      ],
    };
    return true;
  }
  const v = ahead().get(frame.messageId);
  if (v === undefined) return true;
  if (frame.type === "html") {
    stage(frame.messageId, applyHtml(v, frame));
    return true;
  }
  const r = applyDelta(v, frame, Date.now());
  if (r.gap) return false;
  stage(frame.messageId, r.live);
  return true;
}

function onWatched(ev: Extract<SocketEvent, { type: "watched" }>): void {
  const held = session.value;
  if (held === null || held.session.id !== ev.sessionId) return;
  const buffered = pending;
  // an answer nobody waits for: a watch the socket repeated on open,
  // answered before the load that follows sends its own
  if (buffered === null) return;
  pending = null;
  flushLive();
  if (buffered.overflow) {
    refetch();
    return;
  }
  visualPreviews.value = snapshotVisuals(visualPreviews.value, {
    ...held,
    live: ev.live,
  });
  session.value = {
    ...held,
    live: ev.live,
    channelContext: ev.channelContext ?? held.channelContext,
  };
  retries.value = retriesOf(ev.live);
  sequences = new Map(ev.live.map((send) => [send.sendId, send.seq]));
  if (ev.live.length === 0) {
    // the rows say running and the runner has nothing: the end went by
    // before this connection heard it
    if (held.session.status === "running") refetch();
  } else {
    const map = new Map(ahead());
    for (const snap of ev.live) {
      if (snap.phase === "tools") continue;
      const m = held.messages.find((x) => x.id === snap.messageId);
      // a channel turn on a post above the pages held lands by envelope
      if (m === undefined && held.session.origin === "channel") continue;
      if (m === undefined) {
        refetch();
        return;
      }
      map.set(m.id, liveOfSnapshot(snap, m));
    }
    publish(map);
  }
  for (const frame of buffered.buffer) {
    if (frame.seq <= (sequences.get(frame.sendId) ?? -1)) continue;
    if (!applyFrame(frame)) {
      refetch();
      return;
    }
  }
}

export function onSocket(ev: SocketEvent): void {
  switch (ev.type) {
    case "session":
      onEnvelope(ev);
      break;
    case "deleted":
      drop(ev.sessionId, ev.projectId);
      break;
    case "automationDeleted":
      markGone(ev.automationId);
      if (ev.runs) leaveRuns(ev.automationId, ev.projectId);
      break;
    case "granted":
      grantRows(ev.projectId);
      break;
    case "revoked": {
      revokeRows(ev.projectId);
      chatsKept.update((detail) =>
        detail.session.projectId === ev.projectId ? null : detail,
      );
      const held = session.value;
      // the page leaves the chat as a navigation would, so an answer
      // in flight for it and its watch are dropped too
      if (held !== null && held.session.projectId === ev.projectId) {
        leaveSession();
        navigate("/");
      }
      break;
    }
    case "watched":
      onQueueSocket(ev);
      onWatched(ev);
      takeWatched(ev.sessionId, ev.children ?? []);
      onDraftSocket(ev);
      break;
    case "child":
      takeChildren(ev.sessionId, [ev]);
      break;
    case "draft":
      onDraftSocket(ev);
      break;
    case "queue":
    case "notSent":
      onQueueSocket(ev);
      break;
    case "delta":
    case "html":
    case "visual":
    case "restart":
    case "retry":
      if (pending !== null) {
        if (pending.buffer.length >= BUFFER_MAX) pending.overflow = true;
        else pending.buffer.push(ev);
        break;
      }
      if (!applyFrame(ev)) refetch();
      break;
    default:
      break;
  }
}

onSocketEvent(onSocket);
