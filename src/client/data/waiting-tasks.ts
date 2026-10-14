// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home's External tasks card: the tasks awaiting input across the
// user's projects, read by their own query on Home's load, then kept by
// the external task frames by the revision rule. Frames that land while
// a read is out are applied over its answer. A project the user stops or
// starts seeing, a label of a Home project renamed or deleted, and rows
// leaving under the ones the read answered, read them again, one flight
// folding a burst. An admin sees every team
// project, so joining or leaving one sends no such frame: Home's next
// load picks it up.

import { effect, signal } from "@preact/signals";
import type { WaitingTasksResponse } from "../../shared/api/external-tasks.ts";
import {
  ATTENTION_ROWS,
  type ExternalTaskRow,
} from "../../shared/contracts/external-task.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { api } from "./api.ts";
import {
  applyWaiting,
  awaiting,
  dropWaiting,
  type Waiting,
} from "./external-tasks-rows.ts";
import { Flight } from "./flight.ts";
import { me } from "./me.ts";
import { onSocketEvent } from "./socket.ts";

// null until read
export const waitingTasks = signal<Waiting | null>(null);

let owner: string | null = null;
let turn = 0;
// the frames seen while a read is out, the newest row per task
let during: Map<string, ExternalTaskRow> | null = null;
// deleted tasks: a row read before its delete never joins again
const gone = new Set<string>();
// the projects the last read covered; a frame from any other is not Home's
let home: Set<string> | null = null;
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
  home = null;
  waitingTasks.value = null;
});

// fewer rows held than the answer had, while more wait: the card would
// thin out or hide with tasks still to show
const thin = (waiting: Waiting) =>
  waiting.tasks.length < Math.min(waiting.count, ATTENTION_ROWS);

// a row onto the rows held, and whether the count must be read again:
// the card thinned under what waits, or a waiting row not held may be
// one past the rows read, already counted
function step(
  held: Waiting,
  row: ExternalTaskRow,
): { next: Waiting; ask: boolean } {
  const next = applyWaiting(held, row);
  if (next === held) return { next, ask: false };
  const past =
    awaiting(row) &&
    held.count > held.tasks.length &&
    !held.tasks.some((t) => t.id === row.id);
  return { next, ask: thin(next) || past };
}

async function read(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  during = new Map();
  try {
    const body = await api<WaitingTasksResponse>(
      "/api/external-tasks?waiting=1",
    );
    if (owner !== forUser || mine !== turn) return;
    const seen = during;
    during = null;
    home = new Set(body.projectIds);
    const answered: Waiting = {
      tasks: body.tasks.filter((t) => !gone.has(t.id)),
      count: body.count,
    };
    let waiting = answered;
    let ask = false;
    for (const row of seen.values()) {
      if (!home.has(row.projectId)) continue;
      const done = step(waiting, row);
      waiting = done.next;
      ask ||= done.ask;
    }
    waitingTasks.value = waiting;
    if (ask) flight.ask();
  } catch {
    // Home draws no card rather than a failure for it
    if (mine === turn) during = null;
  }
}

export const loadWaitingTasks = (): Promise<void> => flight.run(read);

function take(row: ExternalTaskRow): void {
  if (gone.has(row.id)) return;
  // a read out may cover a project the last one did not; its answer
  // filters what it saw
  const was = during?.get(row.id);
  if (during !== null && (was === undefined || was.revision < row.revision)) {
    during.set(row.id, row);
  }
  if (home !== null && !home.has(row.projectId)) return;
  const held = waitingTasks.value;
  if (held === null) return;
  const { next, ask } = step(held, row);
  if (next === held) return;
  waitingTasks.value = next;
  if (ask) flight.ask();
}

export function onWaitingSocket(ev: SocketEvent): void {
  switch (ev.type) {
    case "externalTask":
      take(ev.task);
      break;
    case "externalTaskDeleted": {
      gone.add(ev.taskId);
      during?.delete(ev.taskId);
      const held = waitingTasks.value;
      if (held === null) break;
      const next = dropWaiting(held, ev.taskId);
      waitingTasks.value = next;
      // a deleted row past the ones held still counts until read again
      if (thin(next) || next.count > next.tasks.length) flight.ask();
      break;
    }
    case "revoked":
    case "granted":
      if (waitingTasks.value !== null) flight.ask();
      break;
    // no row moved, so only a read shows the labels as they are now
    // and while a read is out, whose projects are not known yet
    case "projectLabels":
      if (
        during !== null ||
        (waitingTasks.value !== null && home?.has(ev.projectId))
      ) {
        flight.ask();
      }
      break;
    default:
      break;
  }
}

onSocketEvent(onWaitingSocket);
