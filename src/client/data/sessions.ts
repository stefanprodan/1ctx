// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Durable revisions win over old loads. Stream gaps refetch a snapshot
// rather than leaving a partly applied reply or visual on screen. A
// settled chat is held once seen, so going back to it draws at once
// while it loads again.

import { effect, signal } from "@preact/signals";
import type {
  CreateSessionRequest,
  RegenerateRequest,
  RenameSessionRequest,
  SendMessageRequest,
  SessionResponse,
} from "../../shared/api/sessions.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { navigate } from "../app/router.ts";
import { type Failure, failure } from "../lib/format.ts";
import {
  applyDelta,
  applyHtml,
  type Live,
  liveOf,
  liveOfSnapshot,
} from "../transcript/stream.ts";
import {
  applyVisual,
  type Previews,
  reconcileVisuals,
  snapshotVisuals,
} from "../transcript/visuals.ts";
import { api } from "./api.ts";
import { carry, changeOf } from "./capabilities.ts";
import { Held } from "./held.ts";
import { me } from "./me.ts";
import { resetValues, syncValues } from "./session-values.ts";
import { liveFrom, streams, upsert } from "./sessions-rows.ts";
import { onSocketEvent, watch } from "./socket.ts";
import { applyEnvelope, dropRow, grantRows, revokeRows } from "./stream.ts";

export {
  homeProjectId,
  loadProjectAgents,
  pickHomeProject,
  projectAgentCount,
  projectAgents,
} from "./project-agents.ts";
export {
  loadOpened,
  loadToolResult,
  loadVisual,
  openedFiles,
  toolResults,
  toolVisuals,
} from "./session-values.ts";
export { type ListFilter, list, loadList, loadMore } from "./stream.ts";

// frames kept while the watch is being answered; past this the
// snapshot is refetched instead
export const BUFFER_MAX = 256;

export const session = signal<SessionDetail | null>(null);
export const sessionError = signal<Failure | null>(null);
// the replies streaming on the chat on screen, by message id
export const live = signal<ReadonlyMap<string, Live>>(new Map());
// a send the composer asked for and the server has not answered
export const sending = signal(false);

// A stored call keeps only a marker here. Its mounted frame keeps the paint.
export const visualPreviews = signal<Previews>(new Map());

type Frame = Extract<SocketEvent, { type: "delta" | "html" | "visual" }>;

let owner: string | null = null;
let wanted: { id: string; turn: number } = { id: "", turn: 0 };
// the watch in flight: the frames before its answer, and the sequence
// the next frame must follow once answered
let pending: { buffer: Frame[]; overflow: boolean } | null = null;
let stream: { sendId: string; seq: number } | null = null;
// the settled chats by id
const chatsKept = new Held<SessionDetail>();

const clock = () => Date.now();

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  wanted = { id: "", turn: wanted.turn + 1 };
  session.value = null;
  sessionError.value = null;
  live.value = new Map();
  resetValues();
  visualPreviews.value = new Map();
  chatsKept.clear();
  sending.value = false;
  pending = null;
  stream = null;
});

function show(detail: SessionDetail): void {
  visualPreviews.value = snapshotVisuals(
    reconcileVisuals(visualPreviews.value, detail),
    detail,
  );
  session.value = detail;
  live.value = liveFrom(detail);
  syncValues(detail);
  stream =
    detail.live === null
      ? null
      : { sendId: detail.live.sendId, seq: detail.live.seq };
}

// a chat is held only settled: a running one would miss its frames
function keep(detail: SessionDetail | null): void {
  if (detail === null) return;
  if (detail.session.status === "running" || detail.live !== null) {
    chatsKept.delete(detail.session.id);
  } else chatsKept.set(detail.session.id, detail);
}

function clear(): void {
  session.value = null;
  live.value = new Map();
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
      show(detail);
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
  stream = null;
  keep(session.value);
  clear();
  watch(null);
}

// a write's answer is the detail: applied like an envelope, so the
// socket's copy of the same commit changes nothing
function take(detail: SessionDetail): void {
  const held = session.value;
  if (held === null || held.session.id !== detail.session.id) return;
  if (detail.session.revision <= held.session.revision) return;
  show(detail);
}

export async function createSession(
  body: CreateSessionRequest,
): Promise<SessionDetail> {
  sending.value = true;
  try {
    // the flips made before the chat existed go with its first message
    const sent = changeOf(null);
    const detail = await carry(null, sent, () =>
      api<SessionResponse>("/api/sessions", "POST", { ...body, ...sent }),
    );
    navigate(`/chat/${detail.session.id}`);
    return detail;
  } finally {
    sending.value = false;
  }
}

// a send of any kind answers the detail; the flips the person made ride
// on the two kinds that take them and are forgotten once taken
async function post(id: string, path: string, body?: object): Promise<void> {
  sending.value = true;
  try {
    const at = `/api/sessions/${encodeURIComponent(id)}/${path}`;
    take(
      await carry(id, body ?? {}, () => api<SessionResponse>(at, "POST", body)),
    );
  } finally {
    sending.value = false;
  }
}

export function sendMessage(
  id: string,
  message: string,
  uploads: string[],
): Promise<void> {
  const body: SendMessageRequest = {
    message,
    ...(uploads.length === 0 ? {} : { uploads }),
    ...changeOf(id),
  };
  return post(id, "messages", body);
}

// the last turn goes and its user message is sent again
export const regenerateSession = (id: string): Promise<void> =>
  post(id, "regenerate", changeOf(id) satisfies RegenerateRequest);

// a summary round on its own; the next reply starts from the summary
export const compactSession = (id: string) => post(id, "compact");

// the answer is empty: the end of the send arrives as an envelope
export async function stopSession(id: string): Promise<void> {
  await api(`/api/sessions/${encodeURIComponent(id)}/stop`, "POST");
}

// a rename is not a send: it goes under a reply too, and the composer
// stays free while it is on its way
export async function renameSession(id: string, title: string): Promise<void> {
  const body: RenameSessionRequest = { title };
  const detail = await api<SessionResponse>(
    `/api/sessions/${encodeURIComponent(id)}`,
    "PATCH",
    body,
  );
  take(detail);
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
  if (ev.session.revision <= held.session.revision) return;
  const removed = new Set(ev.removedMessageIds ?? []);
  const messages = upsert(
    held.messages.filter((message) => !removed.has(message.id)),
    ev.messages,
  );
  const map = new Map(live.value);
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
  };
  visualPreviews.value = reconcileVisuals(visualPreviews.value, session.value);
  session.value = {
    ...session.value,
    live:
      ev.session.status !== "running"
        ? null
        : session.value.live && {
            ...session.value.live,
            drafts: [...visualPreviews.value.values()].filter(
              (draft) =>
                draft.phase === "draft" &&
                draft.sendId === session.value?.live?.sendId,
            ),
          },
  };
  syncValues(session.value);
  live.value = map;
  // who archived it and until when are the detail's alone
  if (!held.session.archived && ev.session.archived) refetch();
}

// one detail answers a gap, an overflow, a frame ahead of the buffer
function refetch(): void {
  const held = session.value;
  if (held !== null) void loadSession(held.session.id);
}

function applyFrame(frame: Frame): boolean {
  const held = session.value;
  if (held === null || held.session.id !== frame.sessionId) return true;
  if (stream === null || stream.sendId !== frame.sendId) {
    stream = { sendId: frame.sendId, seq: 0 };
  }
  if (frame.seq !== stream.seq + 1) return false;
  stream.seq = frame.seq;
  if (frame.type === "visual") {
    const row = held.messages.find((row) => row.id === frame.messageId);
    if (!row || row.sendId !== frame.sendId) return false;
    if (row.status !== "streaming") return true;
    const result = applyVisual(visualPreviews.value, frame);
    if (result.gap) return false;
    visualPreviews.value = result.previews;
    const snapshot =
      held.live?.sendId === frame.sendId
        ? held.live
        : {
            phase: "reply" as const,
            sendId: frame.sendId,
            messageId: row.id,
            ...liveOf(row),
            seq: frame.seq,
          };
    session.value = {
      ...held,
      live: {
        ...snapshot,
        seq: frame.seq,
        drafts: [...result.previews.values()].filter(
          (draft) => draft.sendId === frame.sendId && draft.phase === "draft",
        ),
      },
    };
    return true;
  }
  const v = live.value.get(frame.messageId);
  if (v === undefined) return true;
  const map = new Map(live.value);
  if (frame.type === "delta") {
    const r = applyDelta(v, frame, clock());
    if (r.gap) return false;
    map.set(frame.messageId, r.live);
  } else {
    map.set(frame.messageId, applyHtml(v, frame));
  }
  live.value = map;
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
  if (buffered.overflow) {
    refetch();
    return;
  }
  visualPreviews.value = snapshotVisuals(visualPreviews.value, {
    ...held,
    live: ev.live,
  });
  session.value = { ...held, live: ev.live };
  if (ev.live === null) {
    // the rows say running and the runner has nothing: the end went by
    // before this connection heard it
    if (held.session.status === "running") refetch();
  } else if (ev.live.phase === "tools") {
    // a round's tools run: nothing streams, so no live entry and no
    // refetch; the sequence still tracks the send for buffered frames
    stream = { sendId: ev.live.sendId, seq: ev.live.seq };
  } else {
    const snap = ev.live;
    const m = held.messages.find((x) => x.id === snap.messageId);
    if (m === undefined) {
      refetch();
      return;
    }
    const map = new Map(live.value);
    map.set(m.id, liveOfSnapshot(snap, m));
    live.value = map;
    stream = { sendId: snap.sendId, seq: snap.seq };
  }
  for (const frame of buffered.buffer) {
    if (stream !== null && frame.sendId === stream.sendId) {
      if (frame.seq <= stream.seq) continue;
    }
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
      onWatched(ev);
      break;
    case "delta":
    case "html":
    case "visual":
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
