// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home's Not sent card: the user's messages that never started, read by
// their own query, never through the feed. Home's load reads them;
// while the card is watched, the user's notSent event (one of their
// rows turned not sent or went, in any chat, sent to them alone), a
// chat it lists deleted, and a project gone read them again, one flight
// folding a burst into one trailing read. Discard all names the rows
// the card shows, so a row that turned since is never discarded unseen.

import { effect, signal } from "@preact/signals";
import type {
  DiscardNotSentRequest,
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
// read is hoisted, so the flight exists before the user effect runs
const flight = new Flight(read);

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  turn++;
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

export async function discardNotSent(): Promise<void> {
  const ids = (notSent.value ?? []).map((row) => row.id);
  if (ids.length === 0) return;
  const body: DiscardNotSentRequest = { ids };
  await api<DiscardNotSentResponse>("/api/me/not-sent", "DELETE", body);
  notSent.value = (notSent.value ?? []).filter((row) => !ids.includes(row.id));
  await flight.run(read);
}

export function onNotSentSocket(ev: SocketEvent): void {
  if (watchers === 0 || notSent.value === null) return;
  const listed = (id: string) =>
    notSent.value?.some((row) => row.sessionId === id) ?? false;
  if (
    ev.type === "notSent" ||
    ev.type === "revoked" ||
    (ev.type === "deleted" && listed(ev.sessionId))
  ) {
    flight.ask();
  }
}

onSocketEvent(onNotSentSocket);
