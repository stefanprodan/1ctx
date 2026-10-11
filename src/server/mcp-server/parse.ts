// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  type KnowledgeEdit,
  MAX_EDITS,
  parseCreate,
  parseId,
  parseName,
  parseRename,
  parseReplace,
  parseSearch,
} from "../knowledge/index.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

const action = <T extends string>(value: unknown, allowed: readonly T[]): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new BadRequest(`action must be one of ${allowed.join(", ")}`);
  }
  return value as T;
};

const stamp = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new BadRequest("stamp must be a list stamp");
  }
  return value;
};

export type Since = { iso: string; at: number };

const isoTime = (value: unknown, field: string): Since | null => {
  if (value === undefined || value === null) return null;
  const parts =
    typeof value === "string"
      ? value.match(
          /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/,
        )
      : null;
  if (parts === null) {
    throw new BadRequest(`${field} must be an ISO 8601 time`);
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const millisecond = Number((parts[7] ?? "").slice(0, 3).padEnd(3, "0"));
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  const normalized = `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}.${String(millisecond).padStart(3, "0")}${parts[8]}`;
  const at = Date.parse(normalized);
  if (
    !Number.isFinite(at) ||
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second ||
    local.getUTCMilliseconds() !== millisecond
  ) {
    throw new BadRequest(`${field} must be an ISO 8601 time`);
  }
  return { iso: new Date(at).toISOString(), at };
};

const since = (value: unknown): Since | null => isoTime(value, "since");

const optionalString = (value: unknown, field: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new BadRequest(`${field} must be a string`);
  return value;
};

const prefix = (value: unknown): string | null => {
  const picked = optionalString(value, "prefix");
  if (picked === null) return null;
  if (!picked.endsWith("/") || picked.length === 1) {
    throw new BadRequest("prefix must be a knowledge folder ending in /");
  }
  parseName(picked.slice(0, -1));
  return picked;
};

const offset = (value: unknown): number => {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BadRequest("offset must be a non-negative integer");
  }
  return value;
};

const revision = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new BadRequest("revision must be a positive integer");
  }
  return value;
};

export type ProjectsInput = { action: "list"; after: string | null };

export function parseProjects(value: unknown): ProjectsInput {
  const body = fields(value, ["action", "after"]);
  return {
    action: action(body.action, ["list"] as const),
    after:
      body.after === undefined || body.after === null
        ? null
        : parseId(body.after, "after"),
  };
}

export type KnowledgeInput =
  | {
      action: "list";
      projectId: string;
      after: string | null;
      stamp: string | null;
      prefix: string | null;
      since: Since | null;
      readAt: Since | null;
    }
  | {
      action: "search";
      projectId: string;
      q: string;
      after: string | null;
    }
  | {
      action: "read";
      projectId: string;
      fileId: string;
    }
  | {
      action: "versions";
      projectId: string;
      fileId: string;
      after: string | null;
      stamp: string | null;
    }
  | {
      action: "version";
      projectId: string;
      versionId: string;
    }
  | { action: "create"; projectId: string; name: string; text: string }
  | {
      action: "edit";
      projectId: string;
      fileId: string;
      revision: number;
      edits: readonly KnowledgeEdit[];
    }
  | {
      action: "replace";
      projectId: string;
      fileId: string;
      revision: number;
      text: string;
    }
  | {
      action: "rename";
      projectId: string;
      fileId: string;
      revision: number;
      name: string;
    }
  | {
      action: "delete";
      projectId: string;
      fileId: string;
      revision: number;
    };

function exactEditText(value: string): string {
  if (!value.isWellFormed() || value.includes("\u0000")) {
    throw new BadRequest("not a text file");
  }
  return value;
}

function edits(value: unknown): readonly KnowledgeEdit[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EDITS) {
    throw new BadRequest(`edits must have 1 to ${MAX_EDITS} pairs`);
  }
  return value.map((raw, index) => {
    const pair = fields(raw, ["old", "new"]);
    if (typeof pair.old !== "string" || pair.old === "") {
      throw new BadRequest(`edit ${index + 1} old must be a non-empty string`);
    }
    if (typeof pair.new !== "string") {
      throw new BadRequest(`edit ${index + 1} new must be a string`);
    }
    return {
      old: exactEditText(pair.old),
      new: exactEditText(pair.new),
    };
  });
}

export function parseKnowledge(value: unknown): KnowledgeInput {
  const head = fields(value, [
    "action",
    "projectId",
    "after",
    "stamp",
    "prefix",
    "since",
    "readAt",
    "q",
    "fileId",
    "versionId",
    "revision",
    "name",
    "text",
    "edits",
  ]);
  const picked = action(head.action, [
    "list",
    "search",
    "read",
    "versions",
    "version",
    "create",
    "edit",
    "replace",
    "rename",
    "delete",
  ] as const);
  const projectId = parseId(head.projectId, "projectId");
  if (picked === "list") {
    fields(value, [
      "action",
      "projectId",
      "after",
      "stamp",
      "prefix",
      "since",
      "readAt",
    ]);
    const after =
      head.after === undefined || head.after === null
        ? null
        : parseName(head.after);
    const listStamp = stamp(head.stamp);
    if (after !== null && listStamp === null) {
      throw new BadRequest("stamp is required with after");
    }
    if (after === null && listStamp !== null) {
      throw new BadRequest("stamp requires after");
    }
    const readAt = isoTime(head.readAt, "readAt");
    if (after !== null && readAt === null) {
      throw new BadRequest("readAt is required with after");
    }
    if (after === null && readAt !== null) {
      throw new BadRequest("readAt requires after");
    }
    return {
      action: picked,
      projectId,
      after,
      stamp: listStamp,
      prefix: prefix(head.prefix),
      since: since(head.since),
      readAt,
    };
  }
  if (picked === "search") {
    fields(value, ["action", "projectId", "q", "after"]);
    const q = optionalString(head.q, "q");
    if (q === null) throw new BadRequest("q must be a string");
    const url = new URL("http://mcp/knowledge");
    url.searchParams.set("q", q);
    if (head.after !== undefined && head.after !== null) {
      url.searchParams.set("after", parseName(head.after));
    }
    const parsed = parseSearch(url);
    return { action: picked, projectId, ...parsed };
  }
  if (picked === "read") {
    fields(value, ["action", "projectId", "fileId"]);
    return {
      action: picked,
      projectId,
      fileId: parseId(head.fileId, "fileId"),
    };
  }
  if (picked === "versions") {
    fields(value, ["action", "projectId", "fileId", "after", "stamp"]);
    const after =
      head.after === undefined || head.after === null
        ? null
        : parseId(head.after, "after");
    const listStamp = stamp(head.stamp);
    if (after !== null && listStamp === null) {
      throw new BadRequest("stamp is required with after");
    }
    if (after === null && listStamp !== null) {
      throw new BadRequest("stamp requires after");
    }
    return {
      action: picked,
      projectId,
      fileId: parseId(head.fileId, "fileId"),
      after,
      stamp: listStamp,
    };
  }
  if (picked === "version") {
    fields(value, ["action", "projectId", "versionId"]);
    return {
      action: picked,
      projectId,
      versionId: parseId(head.versionId, "versionId"),
    };
  }
  if (picked === "create") {
    fields(value, ["action", "projectId", "name", "text"]);
    return {
      action: picked,
      projectId,
      ...parseCreate({ name: head.name, text: head.text }),
    };
  }
  const fileId = parseId(head.fileId, "fileId");
  const rev = revision(head.revision);
  if (picked === "edit") {
    fields(value, ["action", "projectId", "fileId", "revision", "edits"]);
    return {
      action: picked,
      projectId,
      fileId,
      revision: rev,
      edits: edits(head.edits),
    };
  }
  if (picked === "replace") {
    fields(value, ["action", "projectId", "fileId", "revision", "text"]);
    return {
      action: picked,
      projectId,
      fileId,
      ...parseReplace({ text: head.text, revision: rev }),
    };
  }
  if (picked === "rename") {
    fields(value, ["action", "projectId", "fileId", "revision", "name"]);
    return {
      action: picked,
      projectId,
      fileId,
      ...parseRename({ name: head.name, revision: rev }),
    };
  }
  fields(value, ["action", "projectId", "fileId", "revision"]);
  return { action: picked, projectId, fileId, revision: rev };
}

export type SessionsInput =
  | {
      action: "search";
      projectId: string;
      q: string;
      after: string | null;
    }
  | {
      action: "list";
      projectId: string;
      since: Since | null;
      after: string | null;
      readAt: Since | null;
    }
  | {
      action: "read";
      sessionId: string;
      messageId: string | null;
      offset: number;
    };

export function parseSessions(value: unknown): SessionsInput {
  const head = fields(value, [
    "action",
    "projectId",
    "q",
    "since",
    "after",
    "readAt",
    "sessionId",
    "messageId",
    "offset",
  ]);
  const picked = action(head.action, ["search", "list", "read"] as const);
  if (picked === "read") {
    fields(value, ["action", "sessionId", "messageId", "offset"]);
    return {
      action: picked,
      sessionId: parseId(head.sessionId, "sessionId"),
      messageId:
        head.messageId === undefined || head.messageId === null
          ? null
          : parseId(head.messageId, "messageId"),
      offset: offset(head.offset),
    };
  }
  const projectId = parseId(head.projectId, "projectId");
  const after = optionalString(head.after, "after");
  if (picked === "search") {
    fields(value, ["action", "projectId", "q", "after"]);
    const q = optionalString(head.q, "q");
    if (q === null) throw new BadRequest("q must be a string");
    const url = new URL("http://mcp/sessions");
    url.searchParams.set("q", q);
    const parsed = parseSearch(url);
    return { action: picked, projectId, q: parsed.q, after };
  }
  fields(value, ["action", "projectId", "since", "after", "readAt"]);
  const readAt = isoTime(head.readAt, "readAt");
  if (after !== null && readAt === null) {
    throw new BadRequest("readAt is required with after");
  }
  if (after === null && readAt !== null) {
    throw new BadRequest("readAt requires after");
  }
  return {
    action: picked,
    projectId,
    since: since(head.since),
    after,
    readAt,
  };
}
