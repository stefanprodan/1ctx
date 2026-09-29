// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home's Not sent card: the user's messages that never started, read by
// their own query, never through the feed. Home's load reads them; while
// the card is watched, a queue change in a chat it lists, or in a chat
// where this tab saw one of the user's messages wait, reads them again.
// A queue change is an envelope without rows, and one flight folds a
// burst of them into one trailing read.

import { effect, signal } from "@preact/signals";
import type {
  DiscardNotSentResponse,
  NotSentResponse,
  NotSentRow,
} from "../../shared/api/sessions.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { Flight } from "./flight.ts";
import { me } from "./me.ts";
import { onSocketEvent } from "./socket.ts";

// null until read
export const notSent = signal<NotSentRow[] | null>(null);
export const notSentError = signal<Failure | null>(null);

let owner: string | null = null;
let turn = 0;
let watchers = 0;
// chats where a message of the user's was seen waiting: one may turn
// not sent there
const waiting = new Set<string>();
// read is hoisted, so the flight exists before the user effect runs
const flight = new Flight(read);

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  turn++;
  waiting.clear();
  flight.stop();
  notSent.value = null;
  notSentError.value = null;
});

async function read(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  const current = () => owner === forUser && mine === turn;
  try {
    const body = await api<NotSentResponse>("/api/me/not-sent");
    if (!current()) return;
    notSent.value = body.rows;
    notSentError.value = null;
  } catch (err) {
    if (current()) notSentError.value = failure(err);
  }
}

export const loadNotSent = (): Promise<void> => flight.run(read);

// the card on screen; the cleanup lets go
export function watchNotSent(): () => void {
  watchers++;
  return () => {
    watchers--;
  };
}

// the rows a chat shows: one of the user's waiting may turn not sent
export function noteWaits(
  sessionId: string,
  rows: readonly { author: { id: string } }[],
): void {
  const id = me.value?.id;
  if (rows.some((row) => row.author.id === id)) waiting.add(sessionId);
}

export async function discardNotSent(): Promise<void> {
  await api<DiscardNotSentResponse>("/api/me/not-sent", "DELETE");
  notSent.value = [];
  await flight.run(read);
}

export function onNotSentSocket(ev: SocketEvent): void {
  if (watchers === 0 || notSent.value === null) return;
  if (ev.type === "revoked") {
    flight.ask();
    return;
  }
  if (ev.type !== "session" || ev.messages.length > 0) return;
  const id = ev.session.id;
  if (waiting.has(id) || notSent.value.some((row) => row.sessionId === id)) {
    flight.ask();
  }
}

onSocketEvent(onNotSentSocket);
