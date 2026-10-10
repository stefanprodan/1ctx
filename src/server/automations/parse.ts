// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  PatchAutomationRequest,
  SaveAutomationRequest,
} from "../../shared/api/automations.ts";
import {
  MAX_CAPABILITY_KEY,
  MAX_DISABLED_CAPABILITIES,
  parseSet,
} from "../../shared/capabilities.ts";
import { sanitize } from "../../shared/memory.ts";
import {
  isAttentionMode,
  isRunFilter,
  MAX_ATTENTION_GUIDANCE,
  MAX_MEMORY_GUIDANCE,
  MAX_MESSAGE_BYTES,
  MAX_SCHEDULE,
  MAX_TZ,
  RETENTION_DAYS,
  type RunFilter,
} from "../../shared/words.ts";
import { fields, parseName, queryParams } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import { parseRunsCursor, type RunsCursor } from "../sessions/index.ts";

export const MAX_AUTOMATION_BODY =
  MAX_MESSAGE_BYTES +
  MAX_MEMORY_GUIDANCE +
  MAX_ATTENTION_GUIDANCE +
  MAX_DISABLED_CAPABILITIES * (MAX_CAPABILITY_KEY + 3) +
  2048;
const KEYS = [
  "name",
  "agentId",
  "instructions",
  "schedule",
  "tz",
  "deadlineMs",
  "retentionDays",
  "ownMemory",
];

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new BadRequest(`${name} must be text`);
  }
  return value;
}

// text the agent reads, cleaned, at most max bytes
function guidance(value: unknown, field: string, label: string, max: number) {
  if (typeof value !== "string") throw new BadRequest(`${field} must be text`);
  const cleaned = sanitize(value);
  if (Buffer.byteLength(cleaned) > max) {
    throw new BadRequest(`${label} must be at most ${max} bytes`);
  }
  return cleaned;
}

type AutomationValues = Omit<PatchAutomationRequest, "editRevision">;

function parseValues(
  body: Record<string, unknown>,
  required: boolean,
): AutomationValues {
  const out: AutomationValues = {};
  const take = (name: string) => required || Object.hasOwn(body, name);
  // a field a create leaves out takes its default
  const given = (name: string, fallback: unknown) =>
    Object.hasOwn(body, name) ? body[name] : fallback;
  if (take("name")) out.name = parseName(body.name);
  if (take("agentId")) out.agentId = text(body.agentId, "agentId");
  if (take("instructions")) {
    const instructions = text(body.instructions, "instructions");
    if (instructions.trim() === "") {
      throw new BadRequest("instructions must not be blank");
    }
    if (Buffer.byteLength(instructions) > MAX_MESSAGE_BYTES) {
      throw new BadRequest(
        `instructions must be at most ${MAX_MESSAGE_BYTES} bytes`,
      );
    }
    out.instructions = instructions;
  }
  if (take("schedule")) out.schedule = text(body.schedule, "schedule");
  if (take("tz")) out.tz = text(body.tz, "tz");
  if (take("deadlineMs")) {
    const value = body.deadlineMs;
    if (value !== null && (!Number.isInteger(value) || (value as number) < 1)) {
      throw new BadRequest("deadline must be above zero");
    }
    out.deadlineMs = value as number | null;
  }
  if (take("retentionDays")) {
    const value = body.retentionDays;
    if (
      !Number.isInteger(value) ||
      (value as number) < RETENTION_DAYS.min ||
      (value as number) > RETENTION_DAYS.max
    ) {
      throw new BadRequest(
        `retention must be from ${RETENTION_DAYS.min} to ${RETENTION_DAYS.max} days`,
      );
    }
    out.retentionDays = value as number;
  }
  if (take("ownMemory")) {
    if (typeof body.ownMemory !== "boolean") {
      throw new BadRequest("ownMemory must be boolean");
    }
    out.ownMemory = body.ownMemory;
  }
  if (take("rerunOnRestart")) {
    const value = given("rerunOnRestart", false);
    if (typeof value !== "boolean") {
      throw new BadRequest("rerunOnRestart must be boolean");
    }
    out.rerunOnRestart = value;
  }
  if (take("once")) {
    const value = given("once", false);
    if (typeof value !== "boolean") {
      throw new BadRequest("once must be boolean");
    }
    out.once = value;
  }
  if (take("memoryGuidance")) {
    out.memoryGuidance = guidance(
      given("memoryGuidance", ""),
      "memoryGuidance",
      "memory guidance",
      MAX_MEMORY_GUIDANCE,
    );
  }
  if (take("attentionMode")) {
    const value = given("attentionMode", "agent");
    if (!isAttentionMode(value)) {
      throw new BadRequest("attentionMode must be off, agent or decider");
    }
    out.attentionMode = value;
  }
  if (take("attentionGuidance")) {
    out.attentionGuidance = guidance(
      given("attentionGuidance", ""),
      "attentionGuidance",
      "attention guidance",
      MAX_ATTENTION_GUIDANCE,
    );
  }
  if (take("disabledCapabilities")) {
    const parsed = parseSet(
      given("disabledCapabilities", []),
      "disabledCapabilities",
    );
    if (!parsed.ok) throw new BadRequest(parsed.error);
    out.disabledCapabilities = parsed.set;
  }
  return out;
}

// optional on create, with a default
const OPTIONAL = [
  "memoryGuidance",
  "disabledCapabilities",
  "rerunOnRestart",
  "once",
  "attentionMode",
  "attentionGuidance",
];

export function parseSaveAutomation(
  body: unknown,
): Required<SaveAutomationRequest> {
  const parsed = fields(body, [...KEYS, ...OPTIONAL]);
  for (const key of KEYS) {
    if (!Object.hasOwn(parsed, key))
      throw new BadRequest(`missing field ${key}`);
  }
  return parseValues(parsed, true) as Required<SaveAutomationRequest>;
}

export function parsePatchAutomation(body: unknown): {
  patch: AutomationValues;
  editRevision: number;
} {
  const { editRevision, ...parsed } = fields(body, [
    ...KEYS,
    ...OPTIONAL,
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
  return { patch: parseValues(parsed, false), editRevision };
}

export function parseRunsQuery(url: URL): {
  filter: RunFilter | null;
  before: RunsCursor | null;
} {
  const get = queryParams(url, ["filter", "before"]);
  const filter = get("filter");
  if (filter !== null && !isRunFilter(filter)) {
    throw new BadRequest("filter must be manual or attention");
  }
  const before = get("before");
  return {
    filter,
    before: before === null ? null : parseRunsCursor(before),
  };
}

// ?runs=delete deletes the automation's runs with it; without it they
// stay, their automation gone
export function parseDeleteAutomation(url: URL): { runs: boolean } {
  const runs = queryParams(url, ["runs"])("runs");
  if (runs !== null && runs !== "delete") {
    throw new BadRequest("runs must be delete");
  }
  return { runs: runs !== null };
}

export function parseSchedulePreview(url: URL): {
  schedule: string;
  tz: string;
} {
  const get = queryParams(url, ["schedule", "tz"]);
  const schedule = get("schedule")?.trim();
  const tz = get("tz")?.trim();
  if (schedule === undefined || schedule.length > MAX_SCHEDULE) {
    throw new BadRequest("invalid schedule");
  }
  if (tz === undefined || tz.length > MAX_TZ) {
    throw new BadRequest("invalid time zone");
  }
  return { schedule, tz };
}
