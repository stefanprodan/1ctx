// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The memory notes entity: a project's note and an automation's, held
// by key once a page reads them and dropped with the signed-in user. A
// write keeps the row the server answered; a memory frame refetches
// the note when its revision is above the one held, so a run's commit
// on another tab reaches this one.

import { effect, signal } from "@preact/signals";
import type {
  MemoryResponse,
  SaveMemoryRequest,
  UndoMemoryRequest,
} from "../../shared/api/memory.ts";
import type { Memory } from "../../shared/contracts/memory.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";
import { onSocketEvent } from "./socket.ts";

export const notes = signal<ReadonlyMap<string, Memory>>(new Map());
export const noteErrors = signal<ReadonlyMap<string, Failure>>(new Map());

let owner: string | null = null;
const turns = new Map<string, number>();

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  turns.clear();
  notes.value = new Map();
  noteErrors.value = new Map();
});

// the project's note, or an automation's
export const keyOf = (projectId: string, automationId: string | null) =>
  automationId === null ? `project:${projectId}` : `automation:${automationId}`;

function pathOf(key: string): string {
  const [kind, id] = key.split(":", 2) as [string, string];
  const base = kind === "project" ? "projects" : "automations";
  return `/api/${base}/${encodeURIComponent(id)}/memory`;
}

export function noteOf(key: string): Memory | null {
  return notes.value.get(key) ?? null;
}

function keep(key: string, memory: Memory): void {
  // a later word on the row never loses to an earlier answer
  const held = notes.value.get(key);
  if (held !== undefined && held.revision > memory.revision) return;
  const next = new Map(notes.value);
  next.set(key, memory);
  notes.value = next;
  if (noteErrors.value.has(key)) {
    const errors = new Map(noteErrors.value);
    errors.delete(key);
    noteErrors.value = errors;
  }
}

// a load's answer is kept only when it is still the one wanted: for
// the signed-in user of the moment and the latest word on the key
export async function loadMemory(key: string): Promise<void> {
  const forUser = owner;
  const mine = (turns.get(key) ?? 0) + 1;
  turns.set(key, mine);
  try {
    const { memory } = await api<MemoryResponse>(pathOf(key));
    if (owner === forUser && turns.get(key) === mine) keep(key, memory);
  } catch (err) {
    if (owner === forUser && turns.get(key) === mine) {
      const errors = new Map(noteErrors.value);
      errors.set(key, failure(err));
      noteErrors.value = errors;
    }
  }
}

export async function saveMemory(
  key: string,
  body: SaveMemoryRequest,
): Promise<Memory> {
  const forUser = owner;
  turns.set(key, (turns.get(key) ?? 0) + 1);
  const { memory } = await api<MemoryResponse>(pathOf(key), "PUT", body);
  if (owner === forUser) keep(key, memory);
  return memory;
}

export async function undoMemory(
  key: string,
  body: UndoMemoryRequest,
): Promise<Memory> {
  const forUser = owner;
  turns.set(key, (turns.get(key) ?? 0) + 1);
  const { memory } = await api<MemoryResponse>(
    `${pathOf(key)}/undo`,
    "POST",
    body,
  );
  if (owner === forUser) keep(key, memory);
  return memory;
}

export function onMemorySocket(ev: SocketEvent): void {
  if (ev.type !== "memory") return;
  const key = keyOf(ev.projectId, ev.automationId);
  // with no row held a load is in flight, and this one supersedes it
  const held = notes.value.get(key);
  if (held !== undefined && held.revision >= ev.revision) return;
  void loadMemory(key);
}

onSocketEvent(onMemorySocket);
