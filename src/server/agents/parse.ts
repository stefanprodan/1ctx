// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agent request parser: a name, a provider id, a model id and the
// system prompt. That the provider exists and the catalog lists the
// model is the route's check, not the parser's.

import type { SaveAgentRequest } from "../../shared/api/agents.ts";
import {
  isAvatar,
  isMcpMode,
  MAX_CONTEXT_LENGTH,
  MAX_SKILLS_PER_AGENT,
  MIN_CONTEXT_LENGTH,
} from "../../shared/words.ts";
import { fields, parseModel, parseName, refusal } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

export const MAX_PROMPT = 16_000;
const MAX_UPSTREAM = 100;

export type ParsedAgent = Omit<
  SaveAgentRequest,
  | "effort"
  | "mcp"
  | "mcpMode"
  | "contextLength"
  | "tools"
  | "upstream"
  | "skip4Bit"
  | "subagents"
  | "images"
  | "default"
> & {
  upstream: string | null;
  skip4Bit: boolean;
  subagents: boolean;
  effort: string | null;
  // null leaves it as it is, on for a new agent
  mcp: boolean | null;
  mcpMode: NonNullable<SaveAgentRequest["mcpMode"]>;
  // null when the body did not state them
  stated: { contextLength: number | null; tools: boolean } | null;
  // null when the body did not state it
  images: boolean | null;
  // null leaves the default mark as it is
  mark: boolean | null;
};

// the field parsers provision shares; null leaves the name to its path
export function parseThinking(
  value: unknown,
  field: string | null = "thinking",
): ParsedAgent["thinking"] {
  if (value !== null && value !== "on" && value !== "off") {
    throw refusal(field, "must be on, off or null");
  }
  return value;
}

export function parseEffort(
  value: unknown,
  field: string | null = "effort",
): string | null {
  if (value !== null && typeof value !== "string") {
    throw refusal(field, "must be text or null");
  }
  return value;
}

// trimmed, and empty when left out
export function parsePrompt(
  value: unknown,
  field: string | null = "prompt",
): string {
  const prompt = value ?? "";
  if (typeof prompt !== "string" || prompt.length > MAX_PROMPT) {
    throw refusal(field, `must be text of at most ${MAX_PROMPT} characters`);
  }
  return prompt.trim();
}

export function parseAgent(body: unknown): ParsedAgent {
  if (body !== null && typeof body === "object" && "servers" in body) {
    throw new BadRequest(
      "servers is gone: a project chooses its MCP servers, an agent has mcp",
    );
  }
  const b = fields(body, [
    "name",
    "avatar",
    "providerId",
    "model",
    "thinking",
    "effort",
    "prompt",
    "skills",
    "mcp",
    "mcpMode",
    "contextLength",
    "tools",
    "upstream",
    "skip4Bit",
    "subagents",
    "images",
    "default",
  ]);
  const name = parseName(b.name);
  if (typeof b.providerId !== "string" || b.providerId === "") {
    throw new BadRequest("providerId must be an id");
  }
  const model = parseModel(b.model);
  const thinking = parseThinking(b.thinking);
  const effort = parseEffort(b.effort);
  const avatar = b.avatar ?? "bot";
  if (!isAvatar(avatar)) throw new BadRequest("avatar must be a known one");
  const prompt = parsePrompt(b.prompt);
  const skills = b.skills ?? [];
  if (
    !Array.isArray(skills) ||
    skills.some((id) => typeof id !== "string" || id === "")
  ) {
    throw new BadRequest("skills must be an array of ids");
  }
  if (skills.length > MAX_SKILLS_PER_AGENT) {
    throw new BadRequest(
      `an agent may have at most ${MAX_SKILLS_PER_AGENT} skills`,
    );
  }
  if (new Set(skills).size !== skills.length) {
    throw new BadRequest("skills must not repeat");
  }
  if (b.mcp !== undefined && typeof b.mcp !== "boolean") {
    throw new BadRequest("mcp must be true or false");
  }
  if (!isMcpMode(b.mcpMode)) {
    throw new BadRequest("mcpMode must be all, catalog or auto");
  }
  const mcpMode = b.mcpMode;
  const contextLength = b.contextLength ?? null;
  if (
    contextLength !== null &&
    (typeof contextLength !== "number" ||
      !Number.isInteger(contextLength) ||
      contextLength < MIN_CONTEXT_LENGTH ||
      contextLength > MAX_CONTEXT_LENGTH)
  ) {
    throw new BadRequest(
      `contextLength must be a whole number of tokens from ${MIN_CONTEXT_LENGTH} to ${MAX_CONTEXT_LENGTH}`,
    );
  }
  if (b.tools !== undefined && typeof b.tools !== "boolean") {
    throw new BadRequest("tools must be true or false");
  }
  // an OpenRouter endpoint tag: a provider slug, maybe a quantization
  const upstream = b.upstream ?? null;
  if (
    upstream !== null &&
    (typeof upstream !== "string" ||
      upstream.length > MAX_UPSTREAM ||
      !/^\w[\w.-]*(\/\w[\w.-]*)*$/.test(upstream))
  ) {
    throw new BadRequest("upstream must be an endpoint tag or null");
  }
  if (b.skip4Bit !== undefined && typeof b.skip4Bit !== "boolean") {
    throw new BadRequest("skip4Bit must be true or false");
  }
  if (b.subagents !== undefined && typeof b.subagents !== "boolean") {
    throw new BadRequest("subagents must be true or false");
  }
  if (b.images !== undefined && typeof b.images !== "boolean") {
    throw new BadRequest("images must be true or false");
  }
  if (b.default !== undefined && typeof b.default !== "boolean") {
    throw new BadRequest("default must be true or false");
  }
  const stated =
    contextLength === null && b.tools === undefined
      ? null
      : { contextLength, tools: b.tools ?? false };
  return {
    name,
    avatar,
    providerId: b.providerId,
    model,
    thinking,
    effort,
    prompt,
    skills,
    mcp: b.mcp ?? null,
    mcpMode,
    upstream,
    skip4Bit: b.skip4Bit ?? false,
    subagents: b.subagents ?? false,
    stated,
    images: b.images ?? null,
    mark: b.default ?? null,
  };
}
