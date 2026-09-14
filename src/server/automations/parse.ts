// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  PatchAutomationRequest,
  SaveAutomationRequest,
} from "../../shared/api/automations.ts";
import {
  isName,
  MAX_MESSAGE_BYTES,
  RETENTION_DAYS,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

export const MAX_AUTOMATION_BODY = MAX_MESSAGE_BYTES + 2048;
const KEYS = [
  "name",
  "agentId",
  "instructions",
  "schedule",
  "tz",
  "deadlineMs",
  "retentionDays",
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
      throw new BadRequest("deadlineMs must be null or a positive integer");
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
        `retentionDays must be from ${RETENTION_DAYS.min} to ${RETENTION_DAYS.max}`,
      );
    }
    out.retentionDays = value as number;
  }
  return out;
}

export function parseSaveAutomation(body: unknown): SaveAutomationRequest {
  const parsed = fields(body, KEYS);
  for (const key of KEYS) {
    if (!Object.hasOwn(parsed, key))
      throw new BadRequest(`missing field ${key}`);
  }
  return parseValues(parsed, true) as SaveAutomationRequest;
}

export function parsePatchAutomation(body: unknown): PatchAutomationRequest {
  const parsed = fields(body, KEYS);
  if (Object.keys(parsed).length === 0) throw new BadRequest("empty patch");
  return parseValues(parsed, false);
}
