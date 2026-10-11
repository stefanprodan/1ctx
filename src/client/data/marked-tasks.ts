// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home's External tasks card: the marked tasks across the user's
// projects, read by their own query on Home's load, then kept by the
// external task frames by the revision rule. Frames that land while a
// read is out are applied over its answer. A project the user stops or
// starts seeing, and rows cleared under the ones the read answered,
// read them again, one flight folding a burst.

import { effect, signal } from "@preact/signals";
import type { AttentionTasksResponse } from "../../shared/api/external-tasks.ts";
import {
  ATTENTION_ROWS,
  type ExternalTaskRow,
} from "../../shared/contracts/external-task.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { api } from "./api.ts";
import { applyMarked, dropMarked, type Marked } from "./external-tasks-rows.ts";
import { Flight } from "./flight.ts";
import { me } from "./me.ts";
import { onSocketEvent } from "./socket.ts";

// null until read
export const markedTasks = signal<Marked | null>(null);

let owner: string | null = null;
let turn = 0;
// the frames seen while a read is out, the newest row per task
let during: Map<string, ExternalTaskRow> | null = null;
// deleted tasks: a row read before its delete never joins again
const gone = new Set<string>();
// read is hoisted, so the flight exists before the user effect runs
const flight = new Flight(read);

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  turn++;
  during = null;
  flight.stop();
  gone.clear();
  markedTasks.value = null;
});

// fewer rows held than the answer had, while more are marked: the card
// would thin out or hide with tasks still to show
const thin = (marked: Marked) =>
  marked.tasks.length < Math.min(marked.count, ATTENTION_ROWS);

// a row onto the rows held, and whether the count must be read again:
// the card thinned under what is marked, or a marked row not held may
// be one past the rows read, already counted
function step(
  held: Marked,
  row: ExternalTaskRow,
): { next: Marked; ask: boolean } {
  const next = applyMarked(held, row);
  if (next === held) return { next, ask: false };
  const past =
    row.attentionAt !== null &&
    held.count > held.tasks.length &&
    !held.tasks.some((t) => t.id === row.id);
  return { next, ask: thin(next) || past };
}

async function read(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  during = new Map();
  try {
    const body = await api<AttentionTasksResponse>(
      "/api/external-tasks?attention=1",
    );
    if (owner !== forUser || mine !== turn) return;
    const seen = during;
    during = null;
    const answered: Marked = {
      tasks: body.tasks.filter((t) => !gone.has(t.id)),
      count: body.count,
    };
    let marked = answered;
    let ask = false;
    for (const row of seen.values()) {
      const done = step(marked, row);
      marked = done.next;
      ask ||= done.ask;
    }
    markedTasks.value = marked;
    if (ask) flight.ask();
  } catch {
    // Home draws no card rather than a failure for it
    if (mine === turn) during = null;
  }
}

export const loadMarkedTasks = (): Promise<void> => flight.run(read);

function take(row: ExternalTaskRow): void {
  if (gone.has(row.id)) return;
  const was = during?.get(row.id);
  if (during !== null && (was === undefined || was.revision < row.revision)) {
    during.set(row.id, row);
  }
  const held = markedTasks.value;
  if (held === null) return;
  const { next, ask } = step(held, row);
  if (next === held) return;
  markedTasks.value = next;
  if (ask) flight.ask();
}

export function onMarkedSocket(ev: SocketEvent): void {
  switch (ev.type) {
    case "externalTask":
      take(ev.task);
      break;
    case "externalTaskDeleted": {
      gone.add(ev.taskId);
      during?.delete(ev.taskId);
      const held = markedTasks.value;
      if (held === null) break;
      const next = dropMarked(held, ev.taskId);
      markedTasks.value = next;
      // a deleted row past the ones held still counts until read again
      if (thin(next) || next.count > next.tasks.length) flight.ask();
      break;
    }
    case "revoked":
    case "granted":
      if (markedTasks.value !== null) flight.ask();
      break;
    default:
      break;
  }
}

onSocketEvent(onMarkedSocket);
