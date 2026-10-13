// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  CreateExternalTaskRequest,
  ExternalTaskMoveRequest,
  PatchExternalTaskRequest,
} from "../../shared/api/external-tasks.ts";
import type { MemberMove } from "../../shared/contracts/external-task.ts";
import { isExternalTaskState, MAX_SEARCH } from "../../shared/words.ts";
import { fields, queryParams } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import { ID_SHAPE } from "../lib/ids.ts";
import type { ClosedFilter } from "./lists.ts";
import {
  checkBrief,
  checkEntry,
  MAX_ENTRY_BYTES,
  parseCursor,
} from "./rules.ts";

// JSON can escape each byte of text as six characters.
export const MAX_MOVE_BODY = 6 * MAX_ENTRY_BYTES + 1024;
const BRIEF_KEYS = ["title", "labels", "fileIds"];
const ENTRY_ID = new RegExp(`^${ID_SHAPE}$`);

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new BadRequest(`${name} must be text`);
  return value;
}

function briefValues(body: Record<string, unknown>) {
  const out: Partial<CreateExternalTaskRequest> = {};
  if (Object.hasOwn(body, "title")) out.title = text(body.title, "title");
  for (const key of ["labels", "fileIds"] as const) {
    if (!Object.hasOwn(body, key)) continue;
    const list = body[key];
    if (!Array.isArray(list)) throw new BadRequest(`${key} must be a list`);
    out[key] = list.map((item) => text(item, key));
  }
  // what a patch leaves out stands in as valid, checked on the task
  checkBrief({
    title: out.title ?? "Task",
    labels: out.labels ?? ["kept"],
    fileIds: out.fileIds ?? ["kept"],
  });
  return out;
}

export function parseCreateTask(body: unknown): CreateExternalTaskRequest {
  const parsed = fields(body, BRIEF_KEYS);
  for (const key of BRIEF_KEYS) {
    if (!Object.hasOwn(parsed, key)) {
      throw new BadRequest(`missing field ${key}`);
    }
  }
  const values = briefValues(parsed);
  return {
    title: values.title!,
    labels: values.labels!,
    fileIds: values.fileIds!,
  };
}

export function parsePatchTask(body: unknown): PatchExternalTaskRequest {
  const { editRevision, ...parsed } = fields(body, [
    ...BRIEF_KEYS,
    "editRevision",
  ]);
  if (
    typeof editRevision !== "number" ||
    !Number.isSafeInteger(editRevision) ||
    editRevision < 0
  ) {
    throw new BadRequest("editRevision must be a non-negative integer");
  }
  if (Object.keys(parsed).length === 0) throw new BadRequest("empty patch");
  return { ...briefValues(parsed), editRevision };
}

export function parseMoveTask(
  body: unknown,
  move: MemberMove,
): ExternalTaskMoveRequest {
  const parsed = fields(
    body,
    move === "unclaim" ? ["state", "text", "claimId"] : ["state", "text"],
  );
  if (!isExternalTaskState(parsed.state)) {
    throw new BadRequest("invalid task state");
  }
  const entry =
    move === "cancel" && !Object.hasOwn(parsed, "text")
      ? ""
      : text(parsed.text, "text");
  checkEntry(move, entry, []);
  if (move !== "unclaim") return { state: parsed.state, text: entry };
  const claimId = text(parsed.claimId, "claimId");
  if (claimId === "") throw new BadRequest("claimId must not be empty");
  return { state: parsed.state, text: entry, claimId };
}

// ?closed=1&q=&state=&after=: the closed pages, narrowed by a search
// and done or canceled
export function parseProjectTasks(url: URL): {
  closed: boolean;
  after: string | null;
  filter: ClosedFilter;
} {
  const get = queryParams(url, ["closed", "after", "q", "state"]);
  const closed = get("closed");
  const after = get("after");
  const q = get("q");
  const state = get("state");
  if (closed !== null && closed !== "1") {
    throw new BadRequest("closed must be 1");
  }
  for (const [name, value] of [
    ["after", after],
    ["q", q],
    ["state", state],
  ] as const) {
    if (value !== null && closed === null) {
      throw new BadRequest(`${name} requires closed`);
    }
  }
  if (after !== null) parseCursor(after);
  if (q !== null && q.length > MAX_SEARCH)
    throw new BadRequest("q is too long");
  if (state !== null && state !== "done" && state !== "canceled") {
    throw new BadRequest("state must be done or canceled");
  }
  return {
    closed: closed !== null,
    after,
    filter: { q: (q ?? "").trim(), state },
  };
}

export function parseTaskDetail(url: URL): string | null {
  const before = queryParams(url, ["before"])("before");
  if (before !== null && !ENTRY_ID.test(before)) {
    throw new BadRequest("invalid entry cursor");
  }
  return before;
}

export function parseTaskWaiting(url: URL): void {
  if (queryParams(url, ["waiting"])("waiting") !== "1") {
    throw new BadRequest("waiting must be 1");
  }
}
