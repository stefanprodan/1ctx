// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agent request parser: a name, a provider id, a model id and the
// system prompt. That the provider exists and the catalog lists the
// model is the route's check, not the parser's.

import type { SaveAgentRequest } from "../../shared/api/agents.ts";
import {
  isAvatar,
  isName,
  MAX_NAME,
  MIN_NAME,
  NAME_CHARACTERS,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

export const MAX_MODEL = 200;
export const MAX_PROMPT = 16_000;

export type ParsedAgent = Omit<SaveAgentRequest, "effort"> & {
  effort: string | null;
};

export function parseAgent(body: unknown): ParsedAgent {
  const b = fields(body, [
    "name",
    "avatar",
    "providerId",
    "model",
    "thinking",
    "effort",
    "prompt",
  ]);
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
  if (b.thinking !== null && b.thinking !== "on" && b.thinking !== "off") {
    throw new BadRequest("thinking must be on, off or null");
  }
  if (b.effort !== null && typeof b.effort !== "string") {
    throw new BadRequest("effort must be text or null");
  }
  const avatar = b.avatar ?? "bot";
  if (!isAvatar(avatar)) throw new BadRequest("avatar must be a known one");
  const prompt = b.prompt ?? "";
  if (typeof prompt !== "string" || prompt.length > MAX_PROMPT) {
    throw new BadRequest(
      `prompt must be text of at most ${MAX_PROMPT} characters`,
    );
  }
  return {
    name: b.name,
    avatar,
    providerId: b.providerId,
    model: b.model,
    thinking: b.thinking,
    effort: b.effort,
    prompt: prompt.trim(),
  };
}
