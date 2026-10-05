// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  DECISION_OPTIONS,
  type DecisionId,
  MAX_OPTION_TEXT,
} from "../../shared/contracts/decision.ts";
import {
  isName,
  MAX_NAME,
  MIN_NAME,
  NAME_CHARACTERS,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import type { DecisionFields } from "./decisions.ts";

export const MAX_MODEL = 200;

export type ParsedDecider = {
  name: string;
  providerId: string;
  model: string;
  // null leaves the default mark as it is
  mark: boolean | null;
};

export function parseDecider(body: unknown): ParsedDecider {
  const b = fields(body, ["name", "providerId", "model", "default"]);
  if (!isName(b.name)) {
    throw new BadRequest(
      `name must be ${MIN_NAME} to ${MAX_NAME} ${NAME_CHARACTERS}`,
    );
  }
  if (typeof b.providerId !== "string" || b.providerId === "") {
    throw new BadRequest("providerId must be an id");
  }
  if (
    typeof b.model !== "string" ||
    b.model === "" ||
    b.model.length > MAX_MODEL
  ) {
    throw new BadRequest("model must be a model id");
  }
  if (b.default !== undefined && typeof b.default !== "boolean") {
    throw new BadRequest("default must be true or false");
  }
  return {
    name: b.name,
    providerId: b.providerId,
    model: b.model,
    mark: b.default ?? null,
  };
}

// a decider's name as a path names it, by the same rule a save keeps
export function parseDeciderName(value: unknown): string {
  if (!isName(value)) {
    throw new BadRequest(
      `name must be ${MIN_NAME} to ${MAX_NAME} ${NAME_CHARACTERS}`,
    );
  }
  return value;
}

// a decision's whole settings: every option key of it exactly once
export function parseDecision(id: DecisionId, body: unknown): DecisionFields {
  const b = fields(body, ["enabled", "deciderId", "options"]);
  if (typeof b.enabled !== "boolean") {
    throw new BadRequest("enabled must be true or false");
  }
  const deciderId =
    b.deciderId === null
      ? null
      : typeof b.deciderId === "string" && b.deciderId !== ""
        ? b.deciderId
        : undefined;
  if (deciderId === undefined) {
    throw new BadRequest("deciderId must be an id or null");
  }
  const raw = b.options;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BadRequest("options must be an object");
  }
  const keys = DECISION_OPTIONS[id].map((o) => o.key);
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) throw new BadRequest(`unknown option ${key}`);
  }
  const options: Record<string, string> = {};
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) throw new BadRequest(`options.${key} is missing`);
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "" || text.length > MAX_OPTION_TEXT) {
      throw new BadRequest(
        `options.${key} must be 1 to ${MAX_OPTION_TEXT} characters`,
      );
    }
    options[key] = text;
  }
  return { enabled: b.enabled, deciderId, options };
}
