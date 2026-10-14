// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The external_task tool's arguments: each action takes its own fields
// and refuses the rest, in the words the model reads to fix a call.

import type {
  CreateExternalTaskRequest,
  ExternalTaskMoveRequest,
  PatchExternalTaskRequest,
} from "../../../shared/api/external-tasks.ts";
import {
  EXTERNAL_TASK_STATES,
  type ExternalTaskState,
  isExternalTaskState,
} from "../../../shared/words.ts";
import { ToolError } from "../../lib/errors.ts";
import { UNFINISHED } from "./external-task-text.ts";

export type Move = "answer" | "unclaim" | "cancel" | "reopen";

export const READ_ACTIONS = {
  list: ["action", "states", "after"],
  show: ["action", "id", "before", "entry", "offset"],
} as const;
const WRITE_ACTIONS = {
  create: ["action", "title", "labels", "files"],
  edit: ["action", "id", "editRevision", "title", "labels", "files"],
  answer: ["action", "id", "state", "claimId", "text"],
  unclaim: ["action", "id", "state", "claimId", "text"],
  cancel: ["action", "id", "state", "claimId", "text"],
  reopen: ["action", "id", "state", "text"],
} as const;
export const ACTIONS = { ...READ_ACTIONS, ...WRITE_ACTIONS };
type Action = keyof typeof ACTIONS;

export type Call =
  | { action: "list"; states: ExternalTaskState[]; after: string | null }
  | {
      action: "show";
      id: string;
      before: string | null;
      entry: string | null;
      offset: number | null;
    }
  | { action: "create"; body: CreateExternalTaskRequest; files: string[] }
  | {
      action: "edit";
      id: string;
      body: PatchExternalTaskRequest;
      files: string[] | null;
    }
  | { action: Move; id: string; body: ExternalTaskMoveRequest };

const isAction = (value: unknown, writes: boolean): value is Action =>
  typeof value === "string" &&
  Object.hasOwn(writes ? ACTIONS : READ_ACTIONS, value);

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be text`);
  return value;
}

function whole(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a whole number, 0 or more`);
  return value;
}

function stateOf(value: unknown): ExternalTaskState {
  if (!isExternalTaskState(value)) {
    throw new Error(
      `state must be one of ${EXTERNAL_TASK_STATES.join(", ")}, as show gave it`,
    );
  }
  return value;
}

function brief(args: Record<string, unknown>) {
  const out: Partial<CreateExternalTaskRequest> = {};
  if (args.title !== undefined) out.title = text(args.title, "title");
  if (args.labels !== undefined) {
    if (!Array.isArray(args.labels)) throw new Error("labels must be a list");
    out.labels = args.labels.map((label) => text(label, "a label"));
  }
  let files: string[] | null = null;
  if (args.files !== undefined) {
    if (!Array.isArray(args.files)) throw new Error("files must be a list");
    files = args.files.map((file) => text(file, "a file").trim());
  }
  return { out, files };
}

// the call's arguments, or the words the model reads to fix them
export function parseExternalTaskArgs(
  args: Record<string, unknown>,
  writes = false,
): Call {
  const action = args.action;
  if (!isAction(action, writes)) {
    throw new Error(
      `action must be ${Object.keys(writes ? ACTIONS : READ_ACTIONS).join(", ")}`,
    );
  }
  for (const key of Object.keys(args)) {
    if (!(ACTIONS[action] as readonly string[]).includes(key)) {
      throw new ToolError(
        `${key} is not a field of ${action}`,
        "unknown field",
      );
    }
  }
  if (action === "list") {
    let states = UNFINISHED;
    if (args.states !== undefined) {
      if (
        !Array.isArray(args.states) ||
        args.states.length === 0 ||
        !args.states.every(isExternalTaskState)
      ) {
        throw new Error(
          `states must be a list of ${EXTERNAL_TASK_STATES.join(", ")}`,
        );
      }
      states = [...new Set(args.states)];
    }
    const after =
      args.after === undefined ? null : text(args.after, "after").trim();
    return { action, states, after };
  }
  if (action === "create") {
    const { out, files } = brief(args);
    if (out.title === undefined || out.labels === undefined || files === null) {
      throw new Error("create needs a title, labels and files");
    }
    return {
      action,
      body: { title: out.title, labels: out.labels, fileIds: [] },
      files,
    };
  }
  if (typeof args.id !== "string" || args.id.trim() === "") {
    throw new Error(`${action} needs the task's id, from list`);
  }
  const id = args.id.trim();
  if (action === "show") {
    const entry =
      args.entry === undefined ? null : text(args.entry, "entry").trim();
    const offset =
      args.offset === undefined ? null : whole(args.offset, "offset");
    if ((offset === null) !== (entry === null)) {
      throw new Error("entry and offset go together, from the note");
    }
    if (offset !== null && args.before !== undefined) {
      throw new Error("before pages the entries; leave out offset");
    }
    const before =
      args.before === undefined ? null : text(args.before, "before").trim();
    return { action, id, before, entry, offset };
  }
  if (action === "edit") {
    const editRevision = whole(args.editRevision, "editRevision");
    const { out, files } = brief(args);
    if (Object.keys(out).length === 0 && files === null) {
      throw new Error("edit needs a title, labels or files to change");
    }
    return { action, id, body: { ...out, editRevision }, files };
  }
  const state = stateOf(args.state);
  const said = args.text === undefined ? undefined : text(args.text, "text");
  if (said === undefined && action !== "cancel") {
    throw new Error(
      action === "answer"
        ? "answer needs the text of the answer"
        : `${action} needs a text saying why`,
    );
  }
  const body: ExternalTaskMoveRequest = { state, text: said ?? "" };
  // optional on answer and cancel, where a claim may be live; null there
  // means none, since show prints "Claim: none" and a model echoes it
  if (
    action === "unclaim" ||
    (args.claimId !== undefined && args.claimId !== null)
  ) {
    if (typeof args.claimId !== "string" || args.claimId.trim() === "") {
      throw new Error(`${action} needs the claimId show gave`);
    }
    body.claimId = args.claimId.trim();
  }
  return { action, id, body };
}
