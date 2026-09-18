// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  PatchAutomationRequest,
  SaveAutomationRequest,
} from "../../shared/api/automations.ts";
import { sanitize } from "../../shared/memory.ts";
import {
  isName,
  isRunFilter,
  MAX_MEMORY_GUIDANCE,
  MAX_MESSAGE_BYTES,
  MAX_SCHEDULE,
  MAX_TZ,
  RETENTION_DAYS,
  type RunFilter,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

export const MAX_AUTOMATION_BODY =
  MAX_MESSAGE_BYTES + MAX_MEMORY_GUIDANCE + 2048;
const KEYS = [
  "name",
  "agentId",
  "instructions",
  "schedule",
  "tz",
  "deadlineMs",
  "retentionDays",
  "projectMemory",
  "ownMemory",
];

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new BadRequest(`${name} must be text`);
  }
  return value;
}

function parseValues(
  body: Record<string, unknown>,
  required: boolean,
): PatchAutomationRequest {
  const out: PatchAutomationRequest = {};
  const take = (name: string) => required || Object.hasOwn(body, name);
  if (take("name")) {
    if (!isName(body.name)) throw new BadRequest("invalid name");
    out.name = body.name;
  }
  if (take("agentId")) out.agentId = text(body.agentId, "agentId");
  if (take("instructions")) {
    const instructions = text(body.instructions, "instructions");
    if (instructions.trim() === "") {
      throw new BadRequest("instructions must not be blank");
    }
    if (new TextEncoder().encode(instructions).length > MAX_MESSAGE_BYTES) {
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
  if (take("projectMemory")) {
    if (typeof body.projectMemory !== "boolean") {
      throw new BadRequest("projectMemory must be boolean");
    }
    out.projectMemory = body.projectMemory;
  }
  if (take("ownMemory")) {
    if (typeof body.ownMemory !== "boolean") {
      throw new BadRequest("ownMemory must be boolean");
    }
    out.ownMemory = body.ownMemory;
  }
  if (take("memoryGuidance")) {
    const value = Object.hasOwn(body, "memoryGuidance")
      ? body.memoryGuidance
      : "";
    if (typeof value !== "string") {
      throw new BadRequest("memoryGuidance must be text");
    }
    const guidance = sanitize(value);
    if (new TextEncoder().encode(guidance).length > MAX_MEMORY_GUIDANCE) {
      throw new BadRequest(
        `memory guidance must be at most ${MAX_MEMORY_GUIDANCE} bytes`,
      );
    }
    out.memoryGuidance = guidance;
  }
  return out;
}

export function parseSaveAutomation(
  body: unknown,
): Required<SaveAutomationRequest> {
  const parsed = fields(body, [...KEYS, "memoryGuidance"]);
  for (const key of KEYS) {
    if (!Object.hasOwn(parsed, key))
      throw new BadRequest(`missing field ${key}`);
  }
  return parseValues(parsed, true) as Required<SaveAutomationRequest>;
}

export function parsePatchAutomation(body: unknown): PatchAutomationRequest {
  const parsed = fields(body, [...KEYS, "memoryGuidance"]);
  if (Object.keys(parsed).length === 0) throw new BadRequest("empty patch");
  return parseValues(parsed, false);
}

function queryKeys(url: URL, allowed: string[]): void {
  const seen = new Set<string>();
  for (const name of url.searchParams.keys()) {
    if (!allowed.includes(name)) {
      throw new BadRequest(`unknown parameter ${name}`);
    }
    if (seen.has(name)) throw new BadRequest(`duplicate parameter ${name}`);
    seen.add(name);
  }
}

export function parseRunsQuery(url: URL): RunFilter | null {
  queryKeys(url, ["filter"]);
  const filter = url.searchParams.get("filter");
  if (filter !== null && !isRunFilter(filter)) {
    throw new BadRequest("filter must be failed or manual");
  }
  return filter;
}

export function parseSchedulePreview(url: URL): {
  schedule: string;
  tz: string;
} {
  queryKeys(url, ["schedule", "tz"]);
  const schedule = url.searchParams.get("schedule")?.trim();
  const tz = url.searchParams.get("tz")?.trim();
  if (schedule === undefined || schedule.length > MAX_SCHEDULE) {
    throw new BadRequest("invalid schedule");
  }
  if (tz === undefined || tz.length > MAX_TZ) {
    throw new BadRequest("invalid time zone");
  }
  return { schedule, tz };
}
