// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  MAX_ENTRY_BYTES,
  MAX_ENTRY_LINKS,
  MAX_LINK_BYTES,
  MAX_TASK_LABELS,
} from "../../shared/contracts/external-task.ts";
import { isLabelName, shapeLabelName } from "../../shared/contracts/label.ts";
import {
  AGENT_ENTRY_KINDS,
  type AgentEntryKind,
  EXTERNAL_TASK_STATES,
  type ExternalTaskState,
  isAgentEntryKind,
  isExternalTaskState,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import { optionalBoolean, optionalId, requiredId } from "./parse-values.ts";

export type TasksInput =
  | {
      action: "list";
      projectId: string | null;
      states: ExternalTaskState[];
      // shaped names, any of them; empty for every task
      labels: string[];
      held: boolean;
      // only the tasks this key made
      created: boolean;
      after: string | null;
    }
  | {
      action: "show";
      projectId: string | null;
      taskId: string;
      before: string | null;
    }
  | { action: "claim"; projectId: string | null; taskId: string }
  | {
      action: "unclaim";
      projectId: string | null;
      taskId: string;
      claimId: string;
      text: string;
    }
  | {
      action: "report";
      projectId: string | null;
      taskId: string;
      claimId: string;
      kind: AgentEntryKind;
      text: string;
      links: string[];
    }
  | {
      action: "create";
      projectId: string;
      title: string;
      // as given; the area shapes and checks them as the page's create
      labels: string[];
      fileIds: string[];
    }
  | {
      action: "edit";
      projectId: string | null;
      taskId: string;
      editRevision: number;
      title?: string;
      labels?: string[];
      fileIds?: string[];
    }
  | { action: "cancel"; projectId: string | null; taskId: string };

const action = <T extends string>(value: unknown, allowed: readonly T[]): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new BadRequest(`action must be one of ${allowed.join(", ")}`);
  }
  return value as T;
};

const optionalString = (value: unknown, field: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new BadRequest(`${field} must be a string`);
  }
  return value;
};

const listCursor = (value: unknown): string | null => {
  const cursor = optionalString(value, "after");
  if (cursor !== null && Buffer.byteLength(cursor) > 200) {
    throw new BadRequest("after must be at most 200 bytes");
  }
  return cursor;
};

function taskStates(value: unknown): ExternalTaskState[] {
  if (value === undefined) return ["todo"];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > EXTERNAL_TASK_STATES.length ||
    !value.every(isExternalTaskState)
  ) {
    throw new BadRequest(
      `states must have 1 to ${EXTERNAL_TASK_STATES.length} of ${EXTERNAL_TASK_STATES.join(", ")}`,
    );
  }
  return [...new Set(value)];
}

// a filter, not a check: a name no task carries lists none
function taskLabels(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const rule = `labels must have 1 to ${MAX_TASK_LABELS} label names`;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_TASK_LABELS ||
    !value.every((name) => typeof name === "string")
  ) {
    throw new BadRequest(rule);
  }
  const names = value.map(shapeLabelName);
  if (!names.every(isLabelName)) throw new BadRequest(rule);
  return [...new Set(names)];
}

// a brief's list as given: the area checks it as the page's create does
function briefList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new BadRequest(`${field} must be a list of strings`);
  return value;
}

function briefTitle(value: unknown): string {
  if (typeof value !== "string") throw new BadRequest("title must be a string");
  return value;
}

function reportKind(value: unknown): AgentEntryKind {
  if (!isAgentEntryKind(value)) {
    throw new BadRequest(`kind must be one of ${AGENT_ENTRY_KINDS.join(", ")}`);
  }
  return value;
}

function reportText(value: unknown): string {
  if (typeof value !== "string") {
    throw new BadRequest("text must be a string");
  }
  if (!value.isWellFormed() || value.includes("\u0000")) {
    throw new BadRequest("text must be plain text");
  }
  if (value.trim() === "") {
    throw new BadRequest("text must not be blank");
  }
  if (Buffer.byteLength(value) > MAX_ENTRY_BYTES) {
    throw new BadRequest(`text must be at most ${MAX_ENTRY_BYTES} bytes`);
  }
  return value;
}

function reportLinks(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ENTRY_LINKS) {
    throw new BadRequest(`links must have at most ${MAX_ENTRY_LINKS} links`);
  }
  return value.map((raw, index) => {
    if (
      typeof raw !== "string" ||
      !raw.isWellFormed() ||
      [...raw].some((character) => {
        const point = character.codePointAt(0)!;
        return point < 32 || point === 127;
      })
    ) {
      throw new BadRequest(`link ${index + 1} must be an http(s) URL`);
    }
    if (Buffer.byteLength(raw) > MAX_LINK_BYTES) {
      throw new BadRequest(
        `link ${index + 1} must be at most ${MAX_LINK_BYTES} bytes`,
      );
    }
    let link: URL;
    try {
      link = new URL(raw);
    } catch {
      throw new BadRequest(`link ${index + 1} must be an http(s) URL`);
    }
    if (link.protocol !== "http:" && link.protocol !== "https:") {
      throw new BadRequest(`link ${index + 1} must be an http(s) URL`);
    }
    return raw;
  });
}

export function parseTasks(value: unknown, canHold: boolean): TasksInput {
  const head = fields(value, [
    "action",
    "projectId",
    "states",
    "labels",
    "held",
    "after",
    "taskId",
    "before",
    "claimId",
    "kind",
    "text",
    "links",
    "created",
    "title",
    "fileIds",
    "editRevision",
  ]);
  const picked = action(head.action, [
    "list",
    "show",
    "claim",
    "unclaim",
    "report",
    "create",
    "edit",
    "cancel",
  ] as const);
  if (picked === "list") {
    fields(
      value,
      canHold
        ? [
            "action",
            "projectId",
            "states",
            "labels",
            "held",
            "created",
            "after",
          ]
        : ["action", "projectId", "states", "labels", "after"],
    );
    const held = canHold ? optionalBoolean(head.held, "held") : false;
    const created = canHold ? optionalBoolean(head.created, "created") : false;
    if (held && created) {
      throw new BadRequest("choose held or created, not both");
    }
    return {
      action: picked,
      projectId: optionalId(head.projectId, "projectId"),
      states: taskStates(head.states),
      labels: taskLabels(head.labels),
      held,
      created,
      after: listCursor(head.after),
    };
  }
  if (picked === "create") {
    fields(value, ["action", "projectId", "title", "labels", "fileIds"]);
    return {
      action: picked,
      projectId: requiredId(head.projectId, "projectId"),
      title: briefTitle(head.title),
      labels: briefList(head.labels, "labels"),
      fileIds: briefList(head.fileIds, "fileIds"),
    };
  }
  const taskId = requiredId(head.taskId, "taskId");
  const projectId = optionalId(head.projectId, "projectId");
  if (picked === "show") {
    fields(value, ["action", "projectId", "taskId", "before"]);
    return {
      action: picked,
      projectId,
      taskId,
      before: optionalId(head.before, "before"),
    };
  }
  if (picked === "claim" || picked === "cancel") {
    fields(value, ["action", "projectId", "taskId"]);
    return { action: picked, projectId, taskId };
  }
  if (picked === "edit") {
    fields(value, [
      "action",
      "projectId",
      "taskId",
      "editRevision",
      "title",
      "labels",
      "fileIds",
    ]);
    const { editRevision } = head;
    if (
      typeof editRevision !== "number" ||
      !Number.isSafeInteger(editRevision) ||
      editRevision < 0
    ) {
      throw new BadRequest("editRevision must be a non-negative integer");
    }
    const edit: Extract<TasksInput, { action: "edit" }> = {
      action: picked,
      projectId,
      taskId,
      editRevision,
    };
    if (head.title !== undefined) edit.title = briefTitle(head.title);
    if (head.labels !== undefined)
      edit.labels = briefList(head.labels, "labels");
    if (head.fileIds !== undefined)
      edit.fileIds = briefList(head.fileIds, "fileIds");
    if (
      edit.title === undefined &&
      edit.labels === undefined &&
      edit.fileIds === undefined
    ) {
      throw new BadRequest("edit needs a title, labels or fileIds to change");
    }
    return edit;
  }
  if (picked === "unclaim") {
    fields(value, ["action", "projectId", "taskId", "claimId", "text"]);
    return {
      action: picked,
      projectId,
      taskId,
      claimId: requiredId(head.claimId, "claimId"),
      text: reportText(head.text),
    };
  }
  fields(value, [
    "action",
    "projectId",
    "taskId",
    "claimId",
    "kind",
    "text",
    "links",
  ]);
  return {
    action: picked,
    projectId,
    taskId,
    claimId: requiredId(head.claimId, "claimId"),
    kind: reportKind(head.kind),
    text: reportText(head.text),
    links: reportLinks(head.links),
  };
}
