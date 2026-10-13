// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  MAX_ENTRY_BYTES,
  MAX_ENTRY_LINKS,
  MAX_LINK_BYTES,
} from "../../shared/contracts/external-task.ts";
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

// the entries from the newest, without the brief: a client that sends
// null for an unset field still gets the brief on its first show
export const NEWEST = "newest";

export type TasksInput =
  | {
      action: "list";
      projectId: string | null;
      states: ExternalTaskState[];
      held: boolean;
      after: string | null;
    }
  | {
      action: "show";
      projectId: string | null;
      taskId: string;
      before: string | null;
      includeBrief: boolean;
    }
  | { action: "claim"; projectId: string | null; taskId: string }
  | {
      action: "report";
      projectId: string | null;
      taskId: string;
      claimId: string;
      kind: AgentEntryKind;
      text: string;
      links: string[];
    };

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
    "held",
    "after",
    "taskId",
    "before",
    "claimId",
    "kind",
    "text",
    "links",
  ]);
  const picked = action(head.action, [
    "list",
    "show",
    "claim",
    "report",
  ] as const);
  if (picked === "list") {
    fields(
      value,
      canHold
        ? ["action", "projectId", "states", "held", "after"]
        : ["action", "projectId", "states", "after"],
    );
    return {
      action: picked,
      projectId: optionalId(head.projectId, "projectId"),
      states: taskStates(head.states),
      held: canHold ? optionalBoolean(head.held, "held") : false,
      after: listCursor(head.after),
    };
  }
  const taskId = requiredId(head.taskId, "taskId");
  const projectId = optionalId(head.projectId, "projectId");
  if (picked === "show") {
    fields(value, ["action", "projectId", "taskId", "before"]);
    const newest = head.before === NEWEST;
    const before = newest ? null : optionalId(head.before, "before");
    return {
      action: picked,
      projectId,
      taskId,
      before,
      includeBrief: !newest && before === null,
    };
  }
  if (picked === "claim") {
    fields(value, ["action", "projectId", "taskId"]);
    return { action: picked, projectId, taskId };
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
