// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A move's entry and the task's new state, inside the caller's
// transaction, shared by the actions and the sweeps.

import type { ExternalTaskRow } from "../../shared/contracts/external-task.ts";
import type { ClaimEnd, EntryKind } from "../../shared/words.ts";
import type { BusEvent } from "../lib/bus.ts";
import { NotFound } from "../lib/errors.ts";
import { type Actor, checkEntry, checkMove } from "./rules.ts";
import type { ExternalTaskStore } from "./store.ts";

export const taskChanged = (task: ExternalTaskRow): BusEvent => ({
  type: "externalTask.changed",
  data: { projectId: task.projectId, task },
});

export function required(
  store: ExternalTaskStore,
  id: string,
): ExternalTaskRow {
  const task = store.byId(id);
  if (task === null) throw new NotFound("no such external task");
  return task;
}

export function writeEntry(
  store: ExternalTaskStore,
  task: ExternalTaskRow,
  input: {
    actor: Actor;
    kind: EntryKind;
    text: string;
    links: string[];
    userId: string | null;
    at: number;
  },
) {
  const { actor, kind, text, links, userId, at } = input;
  const state = checkMove(task.state, kind, actor);
  checkEntry(kind, text, links);
  const end: ClaimEnd | null =
    kind === "result"
      ? "done"
      : kind === "cancel" && task.claim !== null
        ? "canceled"
        : kind === "unclaim"
          ? actor === "agent" || actor === "member"
            ? "unclaimed"
            : actor
          : null;
  const claim = task.claim;
  if (claim !== null) {
    store.active(claim.id, at);
    if (end !== null) store.endClaim(claim.id, end, at);
  }
  const id = store.append(task.id, {
    kind,
    text,
    links,
    userId,
    at,
    claimId: actor === "agent" || end !== null ? (claim?.id ?? null) : null,
    keyName: actor === "agent" ? claim!.keyName : null,
    claimEnd: end,
  });
  // a question asked again restarts the wait Home orders by
  store.move(
    task.id,
    state,
    end === null ? (claim?.id ?? null) : null,
    at,
    kind === "question",
  );
  const row = required(store, task.id);
  if (actor === "agent") store.remember(claim!.id, row);
  return { entry: store.entry(task.id, id)!, task: row };
}
