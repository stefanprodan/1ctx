// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Durable revisions win over old loads. Stream gaps refetch a snapshot
// rather than leaving a partly applied reply or visual on screen.

import { effect, signal } from "@preact/signals";
import type {
  CreateSessionRequest,
  ProjectAgentsResponse,
  RenameSessionRequest,
  SendMessageRequest,
  SessionResponse,
} from "../../shared/api/sessions.ts";
import type { AgentSummary } from "../../shared/contracts/agent.ts";
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
import { me } from "./me.ts";
import { resetValues, syncValues } from "./session-values.ts";
import { liveFrom, streams, upsert } from "./sessions-rows.ts";
import { onSocketEvent, watch } from "./socket.ts";
import { applyEnvelope, dropRow, revokeRows } from "./stream.ts";
import { loadUploads } from "./uploads.ts";

export {
  loadToolResult,
  loadVisual,
  toolResults,
  toolVisuals,
} from "./session-values.ts";
export { type ListFilter, list, loadList } from "./stream.ts";

// frames kept while the watch is being answered; past this the
// snapshot is refetched instead
export const BUFFER_MAX = 256;

export const session = signal<SessionDetail | null>(null);
export const sessionError = signal<Failure | null>(null);
// the replies streaming on the chat on screen, by message id
export const live = signal<ReadonlyMap<string, Live>>(new Map());
// the stream's rows for the filter last asked for: Home's, every
// project with a query, or one project's
export const projectAgents = signal<AgentSummary[] | null>(null);
// the project Home's composer starts a chat in, as the user picked it
// for the life of the tab; null for the personal project
export const homeProjectId = signal<string | null>(null);
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
let agentsTurn = 0;
let agentsFor: string | null = null;

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
  projectAgents.value = null;
  agentsFor = null;
  homeProjectId.value = null;
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

export async function loadSession(id: string): Promise<void> {
  const turn = wanted.turn + 1;
  wanted = { id, turn };
  sessionError.value = null;
  if (session.value !== null && session.value.session.id !== id) {
    session.value = null;
    live.value = new Map();
    resetValues();
    visualPreviews.value = new Map();
  }
  try {
    const detail = await api<SessionResponse>(
      `/api/sessions/${encodeURIComponent(id)}`,
    );
    if (wanted.turn !== turn) return;
    // an envelope may have moved the session past this answer while it
    // was in flight; the rows held are then the newer ones
    const held = session.value;
    if (
      held === null ||
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
    if (wanted.turn === turn) sessionError.value = failure(err);
  }
}

// the page left the chat: nothing of it is kept, so a late frame, a
// deletion or a revocation of it moves the page nowhere
// the page leaves a chat: with the id it leaves, nothing happens when
// the load of another chat already owns the entity, as it does on the
// way from a chat to its fork, so that load is not thrown away
export function leaveSession(id?: string): void {
  if (id !== undefined && wanted.id !== "" && wanted.id !== id) return;
  wanted = { id: "", turn: wanted.turn + 1 };
  pending = null;
  stream = null;
  session.value = null;
  live.value = new Map();
  resetValues();
  visualPreviews.value = new Map();
  watch(null);
}

export function projectAgentCount(projectId: string): number | null {
  const list = projectAgents.value;
  return list === null || agentsFor !== projectId ? null : list.length;
}

export async function loadProjectAgents(projectId: string): Promise<void> {
  const forUser = owner;
  const turn = ++agentsTurn;
  if (agentsFor !== projectId) projectAgents.value = null;
  agentsFor = projectId;
  const current = () => owner === forUser && turn === agentsTurn;
  try {
    const body = await api<ProjectAgentsResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/agents`,
    );
    if (current()) projectAgents.value = body.agents;
  } catch {
    if (current()) projectAgents.value = null;
  }
}

// Home's composer moves to another project: its agents replace the
// last project's, none until they answer, so a send never pairs an
// agent with a project it is not in
export async function pickHomeProject(projectId: string): Promise<void> {
  homeProjectId.value = projectId;
  projectAgents.value = null;
  await Promise.all([loadProjectAgents(projectId), loadUploads(projectId)]);
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
    const detail = await api<SessionResponse>("/api/sessions", "POST", body);
    navigate(`/chat/${detail.session.id}`);
    return detail;
  } finally {
    sending.value = false;
  }
}

export async function sendMessage(
  id: string,
  message: string,
  uploads: string[],
): Promise<void> {
  sending.value = true;
  try {
    const body: SendMessageRequest = {
      message,
      ...(uploads.length === 0 ? {} : { uploads }),
    };
    const detail = await api<SessionResponse>(
      `/api/sessions/${encodeURIComponent(id)}/messages`,
      "POST",
      body,
    );
    take(detail);
  } finally {
    sending.value = false;
  }
}

// the last turn goes and its user message is sent again
export async function regenerateSession(id: string): Promise<void> {
  sending.value = true;
  try {
    const detail = await api<SessionResponse>(
      `/api/sessions/${encodeURIComponent(id)}/regenerate`,
      "POST",
    );
    take(detail);
  } finally {
    sending.value = false;
  }
}

// a summary round on its own; the next reply starts from the summary
export async function compactSession(id: string): Promise<void> {
  sending.value = true;
  try {
    const detail = await api<SessionResponse>(
      `/api/sessions/${encodeURIComponent(id)}/compact`,
      "POST",
    );
    take(detail);
  } finally {
    sending.value = false;
  }
}

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

// the row goes from the list and, when it is the chat on screen or
// the one being loaded, the page leaves it and opens its project. An
// answer in flight may still hold the row: the detail's is dropped
// with the watch, the list's is superseded by a load run again. The
// socket's deleted frame after a local delete then finds nothing
function drop(sessionId: string, projectId: string): void {
  dropRow(sessionId, projectId);
  if (wanted.id === sessionId || session.value?.session.id === sessionId) {
    leaveSession();
    navigate(`/projects/${projectId}`);
  }
}

export async function deleteSession(
  id: string,
  projectId: string,
): Promise<void> {
  await api(`/api/sessions/${encodeURIComponent(id)}`, "DELETE");
  drop(id, projectId);
}

// the chat as a Markdown file: a link the browser saves, never a fetch,
// so the cookie and the server's filename do the work. The times are
// in the browser's zone
export const markdownHref = (id: string): string =>
  `/api/sessions/${encodeURIComponent(id)}/markdown?tz=${encodeURIComponent(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  )}`;

function onEnvelope(ev: Extract<SocketEvent, { type: "session" }>): void {
  applyEnvelope(ev);
  const held = session.value;
  if (held === null || held.session.id !== ev.session.id) return;
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
}

// the frames are refetched rather than reasoned about: one detail
// answers a gap, an overflow, or a frame ahead of the buffer
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
    case "revoked": {
      revokeRows(ev.projectId);
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
