// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The knowledge search, per project. The box calls searchKnowledge() on
// every key; the ask goes after a pause in typing. A new query, a clear
// or a user change aborts the request out, so the server drops its scan
// and the new one is not stuck behind it; an answer to a query no longer
// wanted is dropped.

import { effect, signal } from "@preact/signals";
import {
  type KnowledgeSearchResponse,
  SEARCH_MAX,
  SEARCH_MIN,
} from "../../shared/api/knowledge.ts";
import type {
  KnowledgeFile,
  KnowledgeSearchHit,
} from "../../shared/contracts/knowledge.ts";
import { searchTerms } from "../../shared/search.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";
import { onSocketEvent } from "./socket.ts";

export const SEARCH_PAUSE_MS = 250;

export type KnowledgeSearch = {
  // the query as asked, trimmed; empty while idle
  q: string;
  state: "idle" | "loading" | "done" | "failed";
  names: KnowledgeFile[];
  namesTotal: number;
  files: KnowledgeSearchHit[];
  // the cursor of the next page, null on the last
  next: string | null;
  failure: Failure | null;
  more: { loading: boolean; failure: Failure | null };
};

export const SEARCH_IDLE: KnowledgeSearch = {
  q: "",
  state: "idle",
  names: [],
  namesTotal: 0,
  files: [],
  next: null,
  failure: null,
  more: { loading: false, failure: null },
};

export const searches = signal<ReadonlyMap<string, KnowledgeSearch>>(new Map());

export const searchOf = (projectId: string): KnowledgeSearch =>
  searches.value.get(projectId) ?? SEARCH_IDLE;

// the query the box's text asks, or null when too short or holding no
// word to ask
export function searchQuery(text: string): string | null {
  const q = text.trim().slice(0, SEARCH_MAX);
  return q.length < SEARCH_MIN || searchTerms(q).length === 0 ? null : q;
}

// a new query keeps the rows of the last one on screen while it loads,
// so typing does not blink the list
export function asking(held: KnowledgeSearch, q: string): KnowledgeSearch {
  return {
    ...held,
    q,
    state: "loading",
    failure: null,
    more: { loading: false, failure: null },
  };
}

export function answered(
  q: string,
  answer: KnowledgeSearchResponse,
): KnowledgeSearch {
  return {
    q,
    state: "done",
    names: answer.names,
    namesTotal: answer.namesTotal,
    files: answer.files,
    next: answer.next,
    failure: null,
    more: { loading: false, failure: null },
  };
}

// a later page adds its files, by id once; names come on the first page
export function nextPage(
  held: KnowledgeSearch,
  answer: KnowledgeSearchResponse,
): KnowledgeSearch {
  const seen = new Set(held.files.map((hit) => hit.file.id));
  return {
    ...held,
    files: [...held.files, ...answer.files.filter((h) => !seen.has(h.file.id))],
    next: answer.next,
    more: { loading: false, failure: null },
  };
}

let owner: string | null = null;
// the latest word per project: a key, a clear and a user change bump it
const turns = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
// the request out per project, aborted once its answer is unwanted
const flights = new Map<string, AbortController>();

function land(projectId: string): void {
  flights.get(projectId)?.abort();
  flights.delete(projectId);
}

function settled(projectId: string, signal: AbortSignal): void {
  if (flights.get(projectId)?.signal === signal) flights.delete(projectId);
}

function fly(projectId: string): AbortSignal {
  land(projectId);
  const flight = new AbortController();
  flights.set(projectId, flight);
  return flight.signal;
}

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  turns.clear();
  for (const projectId of [...flights.keys()]) land(projectId);
  searches.value = new Map();
});

function put(projectId: string, value: KnowledgeSearch): void {
  const next = new Map(searches.value);
  if (value === SEARCH_IDLE) next.delete(projectId);
  else next.set(projectId, value);
  searches.value = next;
}

const bump = (projectId: string): number => {
  land(projectId);
  const turn = (turns.get(projectId) ?? 0) + 1;
  turns.set(projectId, turn);
  return turn;
};

const searchPath = (projectId: string, q: string, after: string | null) => {
  const query = new URLSearchParams({ q });
  if (after !== null) query.set("after", after);
  return `/api/projects/${encodeURIComponent(projectId)}/knowledge/search?${query}`;
};

export function searchKnowledge(projectId: string, text: string): void {
  const q = searchQuery(text);
  const held = searchOf(projectId);
  if (q === null) {
    clearSearch(projectId);
    return;
  }
  if (q === held.q && held.state !== "failed") return;
  const turn = bump(projectId);
  clearTimeout(timers.get(projectId));
  put(projectId, asking(held, q));
  timers.set(
    projectId,
    setTimeout(() => {
      timers.delete(projectId);
      void ask(projectId, q, turn);
    }, SEARCH_PAUSE_MS),
  );
}

async function ask(projectId: string, q: string, turn: number): Promise<void> {
  const forUser = owner;
  const wanted = () => owner === forUser && turns.get(projectId) === turn;
  if (!wanted()) return;
  const signal = fly(projectId);
  try {
    const answer = await api<KnowledgeSearchResponse>(
      searchPath(projectId, q, null),
      "GET",
      undefined,
      signal,
    );
    if (wanted()) put(projectId, answered(q, answer));
  } catch (err) {
    // an abort is a query overtaken, never a failure
    if (!signal.aborted && wanted()) {
      put(projectId, {
        ...searchOf(projectId),
        state: "failed",
        failure: failure(err),
      });
    }
  } finally {
    settled(projectId, signal);
  }
}

// Show more: the next page of files, after the cursor held
export async function loadMoreSearch(projectId: string): Promise<void> {
  const held = searchOf(projectId);
  if (held.state !== "done" || held.next === null || held.more.loading) return;
  const forUser = owner;
  const turn = turns.get(projectId) ?? 0;
  const wanted = () => owner === forUser && turns.get(projectId) === turn;
  const after = held.next;
  put(projectId, { ...held, more: { loading: true, failure: null } });
  const signal = fly(projectId);
  try {
    const answer = await api<KnowledgeSearchResponse>(
      searchPath(projectId, held.q, after),
      "GET",
      undefined,
      signal,
    );
    if (wanted()) put(projectId, nextPage(searchOf(projectId), answer));
  } catch (err) {
    if (!signal.aborted && wanted()) {
      put(projectId, {
        ...searchOf(projectId),
        more: { loading: false, failure: failure(err) },
      });
    }
  } finally {
    settled(projectId, signal);
  }
}

export function clearSearch(projectId: string): void {
  bump(projectId);
  clearTimeout(timers.get(projectId));
  timers.delete(projectId);
  if (searches.value.has(projectId)) put(projectId, SEARCH_IDLE);
}

// a project no longer seen: its search and its pause go
export function onSearchSocket(ev: SocketEvent): void {
  if (ev.type === "revoked") clearSearch(ev.projectId);
}

onSocketEvent(onSearchSocket);
