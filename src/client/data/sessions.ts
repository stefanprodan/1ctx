// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sessions entity: the chat on screen with the reply in flight,
// the list of one project, and the agents its composer offers. The
// rows come from the routes; the socket keeps them current. A durable
// envelope counts when its revision is above the one held, so the
// answer of a write and the event of the same commit are one change
// however they arrive. The stream frames are applied to the live map
// through the transcript's reducers; a frame out of sequence means the
// detail is fetched again, so the page is never stuck on a gap.
// Every answer is kept only for the user, the id and the turn it was
// asked for, as the projects entity does.

import { effect, signal } from "@preact/signals";
import type {
  CreateSessionRequest,
  ProjectAgentsResponse,
  SendMessageRequest,
  SessionResponse,
  SessionsResponse,
  ToolResultResponse,
} from "../../shared/api/sessions.ts";
import type { AgentSummary } from "../../shared/contracts/agent.ts";
import type {
  Message,
  SessionDetail,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { navigate } from "../app/router.ts";
import {
  applyDelta,
  applyHtml,
  type Live,
  liveOf,
  liveOfSnapshot,
} from "../transcript/stream.ts";
import type { ToolResult } from "../transcript/Tool.model.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";
import { onSocketEvent, watch } from "./socket.ts";

// frames kept while the watch is being answered; past this the
// snapshot is refetched instead
export const BUFFER_MAX = 256;

export const session = signal<SessionDetail | null>(null);
export const sessionError = signal<string | null>(null);
// the replies streaming on the chat on screen, by message id
export const live = signal<ReadonlyMap<string, Live>>(new Map());
export const projectSessions = signal<SessionSummary[] | null>(null);
export const projectAgents = signal<AgentSummary[] | null>(null);
// a send the composer asked for and the server has not answered
export const sending = signal(false);

// the tool results fetched so far, by message id, for the life of the
// chat on screen
export const toolResults = signal<ReadonlyMap<string, ToolResult>>(new Map());

type Frame = Extract<SocketEvent, { type: "delta" | "html" }>;

let owner: string | null = null;
let wanted: { id: string; turn: number } = { id: "", turn: 0 };
let listFor: { projectId: string; turn: number } = { projectId: "", turn: 0 };
// the watch in flight: the frames before its answer, and the sequence
// the next frame must follow once answered
let pending: { buffer: Frame[]; overflow: boolean } | null = null;
let stream: { sendId: string; seq: number } | null = null;
let agentsTurn = 0;

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const clock = () => Date.now();

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  wanted = { id: "", turn: wanted.turn + 1 };
  listFor = { projectId: "", turn: listFor.turn + 1 };
  session.value = null;
  sessionError.value = null;
  live.value = new Map();
  toolResults.value = new Map();
  projectSessions.value = null;
  projectAgents.value = null;
  sending.value = false;
  pending = null;
  stream = null;
});

// the stream's order: running first, then by last activity, newest first
export function ordered(rows: SessionSummary[]): SessionSummary[] {
  return [...rows].sort((a, b) => {
    const ra = a.status === "running" ? 1 : 0;
    const rb = b.status === "running" ? 1 : 0;
    if (ra !== rb) return rb - ra;
    if (a.lastActivityAt !== b.lastActivityAt) {
      return b.lastActivityAt - a.lastActivityAt;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// the rows whose text streams: a reply, and the summary round's row
const streams = (m: Message) => m.kind === "reply" || m.kind === "summary";

// the live map from a detail: the streaming rows, the runner's
// snapshot for the one it is about. The "tools" phase has no row, so
// every streaming row starts from itself
function liveFrom(detail: SessionDetail): Map<string, Live> {
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

// a result held for a row the chat no longer has is dropped with it
function keepResults(keep: (id: string) => boolean): void {
  if (toolResults.value.size === 0) return;
  const next = new Map<string, ToolResult>();
  for (const [id, value] of toolResults.value) {
    if (keep(id)) next.set(id, value);
  }
  toolResults.value = next;
}

function show(detail: SessionDetail): void {
  session.value = detail;
  live.value = liveFrom(detail);
  const ids = new Set(detail.messages.map((m) => m.id));
  keepResults((id) => ids.has(id));
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
    toolResults.value = new Map();
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
    if (wanted.turn === turn) sessionError.value = reason(err);
  }
}

// the page left the chat: nothing of it is kept, so a late frame, a
// deletion or a revocation of it moves the page nowhere
export function leaveSession(): void {
  wanted = { id: "", turn: wanted.turn + 1 };
  pending = null;
  stream = null;
  session.value = null;
  live.value = new Map();
  toolResults.value = new Map();
  watch(null);
}

function setToolResult(messageId: string, value: ToolResult): void {
  const next = new Map(toolResults.value);
  next.set(messageId, value);
  toolResults.value = next;
}

// once per row: a result already held or in flight is not asked again
export async function loadToolResult(messageId: string): Promise<void> {
  const current = session.value;
  if (current === null || toolResults.value.has(messageId)) return;
  const id = current.session.id;
  setToolResult(messageId, { status: "loading" });
  try {
    const answer = await api<ToolResultResponse>(
      `/api/sessions/${encodeURIComponent(id)}/messages/${encodeURIComponent(
        messageId,
      )}/result`,
    );
    if (session.value?.session.id !== id) return;
    setToolResult(messageId, { status: "done", ...answer });
  } catch (err) {
    if (session.value?.session.id !== id) return;
    setToolResult(messageId, { status: "failed", error: reason(err) });
  }
}

export async function loadProjectSessions(projectId: string): Promise<void> {
  const turn = listFor.turn + 1;
  if (listFor.projectId !== projectId) projectSessions.value = null;
  listFor = { projectId, turn };
  try {
    const body = await api<SessionsResponse>(
      `/api/sessions?project=${encodeURIComponent(projectId)}`,
    );
    if (listFor.turn === turn) projectSessions.value = ordered(body.sessions);
  } catch {
    if (listFor.turn === turn) projectSessions.value = null;
  }
}

export async function loadProjectAgents(projectId: string): Promise<void> {
  const forUser = owner;
  const turn = ++agentsTurn;
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

export async function sendMessage(id: string, message: string): Promise<void> {
  sending.value = true;
  try {
    const body: SendMessageRequest = { message };
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

function upsert(rows: Message[], next: Message[]): Message[] {
  const out = rows.slice();
  for (const m of next) {
    const i = out.findIndex((x) => x.id === m.id);
    if (i === -1) out.push(m);
    else out[i] = m;
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function onEnvelope(ev: Extract<SocketEvent, { type: "session" }>): void {
  const list = projectSessions.value;
  if (list !== null && listFor.projectId === ev.projectId) {
    const held = list.find((s) => s.id === ev.session.id);
    if (held === undefined || held.revision < ev.session.revision) {
      projectSessions.value = ordered([
        ...list.filter((s) => s.id !== ev.session.id),
        ev.session,
      ]);
    }
  }
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
  keepResults((id) => !removed.has(id));
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
    case "deleted": {
      const list = projectSessions.value;
      if (list !== null) {
        projectSessions.value = list.filter((s) => s.id !== ev.sessionId);
      }
      const held = session.value;
      if (held !== null && held.session.id === ev.sessionId) {
        session.value = null;
        live.value = new Map();
        toolResults.value = new Map();
        navigate(`/projects/${ev.projectId}`);
      }
      break;
    }
    case "revoked": {
      if (listFor.projectId === ev.projectId) projectSessions.value = null;
      const held = session.value;
      if (held !== null && held.session.projectId === ev.projectId) {
        session.value = null;
        live.value = new Map();
        toolResults.value = new Map();
        navigate("/");
      }
      break;
    }
    case "watched":
      onWatched(ev);
      break;
    case "delta":
    case "html":
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
