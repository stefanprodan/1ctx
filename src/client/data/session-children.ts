// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The subagents' work in the chat on screen, keyed by the delegate row
// (docs/subagents.md): the child frames and a watch's answer while the
// chat is watched, the child route when a group is opened later. A
// frame carries only the rows a commit changed, so each lands on what
// is held; a row never goes back from ended to running, whichever of a
// frame and a read answers last.

import { signal } from "@preact/signals";
import type { ChildWorkResponse } from "../../shared/api/sessions.ts";
import type {
  ChildOf,
  ChildWork,
  Message,
} from "../../shared/contracts/session.ts";
import { says } from "../lib/format.ts";
import { api } from "./api.ts";
import { session } from "./session-held.ts";

export type ChildEntry = {
  work: ChildWork | null;
  loading: boolean;
  error: string | null;
};

export const childWork = signal<ReadonlyMap<string, ChildEntry>>(new Map());
const requests = new Map<string, AbortController>();

const settled = (row: Message) => row.status !== "streaming";

// the newer of two copies: an ended row is never put back to running
function mergeRows(held: Message[], next: Message[]): Message[] {
  const out = new Map(held.map((row) => [row.id, row]));
  for (const row of next) {
    const old = out.get(row.id);
    if (old !== undefined && settled(old) && !settled(row)) continue;
    out.set(row.id, row);
  }
  return [...out.values()].sort((a, b) => a.seq - b.seq);
}

export function mergeWork(held: ChildWork | null, next: ChildWork): ChildWork {
  if (held === null) return { ...next, rows: mergeRows([], next.rows) };
  const ended = held.status !== "running" && next.status === "running";
  return {
    sessionId: next.sessionId,
    status: ended ? held.status : next.status,
    tokens: Math.max(held.tokens, next.tokens),
    cost:
      held.cost === null
        ? next.cost
        : next.cost === null
          ? held.cost
          : Math.max(held.cost, next.cost),
    rows: mergeRows(held.rows, next.rows),
  };
}

const set = (messageId: string, entry: ChildEntry) => {
  childWork.value = new Map(childWork.value).set(messageId, entry);
};

const onScreen = (sessionId: string) => session.value?.session.id === sessionId;

// a frame or a watch's answer for the chat on screen
export function takeChildren(sessionId: string, list: ChildOf[]): void {
  if (!onScreen(sessionId)) return;
  for (const { messageId, child } of list) {
    const held = childWork.value.get(messageId);
    set(messageId, {
      loading: held?.loading ?? false,
      error: null,
      work: mergeWork(held?.work ?? null, child),
    });
  }
}

// a group opened with nothing held reads the child's rows once
export async function loadChild(messageId: string): Promise<void> {
  const chat = session.value?.session.id;
  if (chat === undefined || childWork.value.has(messageId)) return;
  const request = new AbortController();
  requests.set(messageId, request);
  set(messageId, { work: null, loading: true, error: null });
  try {
    const body = await api<ChildWorkResponse>(
      `/api/sessions/${encodeURIComponent(chat)}/messages/${encodeURIComponent(messageId)}/child`,
      "GET",
      undefined,
      request.signal,
    );
    if (requests.get(messageId) !== request) return;
    const held = childWork.value.get(messageId);
    set(messageId, {
      loading: false,
      error: null,
      work: mergeWork(held?.work ?? null, body),
    });
  } catch (error) {
    if (request.signal.aborted || requests.get(messageId) !== request) return;
    set(messageId, {
      loading: false,
      error: says(error),
      work: childWork.value.get(messageId)?.work ?? null,
    });
  } finally {
    if (requests.get(messageId) === request) requests.delete(messageId);
  }
}

// a child's row by id, for a result asked for under the chat
export function childRow(messageId: string): Message | null {
  for (const entry of childWork.value.values()) {
    const row = entry.work?.rows.find((row) => row.id === messageId);
    if (row !== undefined) return row;
  }
  return null;
}

export function childRowIds(): string[] {
  return [...childWork.value.values()].flatMap(
    (entry) => entry.work?.rows.map((row) => row.id) ?? [],
  );
}

export function resetChildren(): void {
  for (const request of requests.values()) request.abort();
  requests.clear();
  childWork.value = new Map();
}
