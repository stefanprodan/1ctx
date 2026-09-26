// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agent request parser: a name, a provider id, a model id and the
// system prompt. That the provider exists and the catalog lists the
// model is the route's check, not the parser's.

import type { SaveAgentRequest } from "../../shared/api/agents.ts";
import type { AgentServer } from "../../shared/contracts/mcp.ts";
import {
  isAvatar,
  isMcpMode,
  isName,
  MAX_CONTEXT_LENGTH,
  MAX_NAME,
  MAX_SKILLS_PER_AGENT,
  MIN_CONTEXT_LENGTH,
  MIN_NAME,
  NAME_CHARACTERS,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

export const MAX_MODEL = 200;
export const MAX_PROMPT = 16_000;
export const MAX_SERVERS_PER_AGENT = 50;
export const MAX_UPSTREAM = 100;

export type ParsedAgent = Omit<
  SaveAgentRequest,
  "effort" | "servers" | "mcpMode" | "contextLength" | "tools" | "upstream"
> & {
  upstream: string | null;
  effort: string | null;
  servers: AgentServer[];
  mcpMode: NonNullable<SaveAgentRequest["mcpMode"]>;
  // null when the body did not state them
  stated: { contextLength: number | null; tools: boolean } | null;
};

// an agent's name as a path names it, by the same rule a save keeps
export function parseAgentName(value: unknown): string {
  if (!isName(value)) {
    throw new BadRequest(
      `name must be ${MIN_NAME} to ${MAX_NAME} ${NAME_CHARACTERS}`,
    );
  }
  return value;
}

function parseServers(value: unknown): AgentServer[] {
  if (!Array.isArray(value)) {
    throw new BadRequest("servers must be an array");
  }
  if (value.length > MAX_SERVERS_PER_AGENT) {
    throw new BadRequest(
      `an agent may have at most ${MAX_SERVERS_PER_AGENT} MCP servers`,
    );
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const server = fields(item, ["serverId", "read", "write"]);
    if (typeof server.serverId !== "string" || server.serverId === "") {
      throw new BadRequest("serverId must be an id");
    }
    if (typeof server.read !== "boolean" || typeof server.write !== "boolean") {
      throw new BadRequest("server read and write must be booleans");
    }
    if (!server.read && !server.write) {
      throw new BadRequest("a server needs read or write");
    }
    if (seen.has(server.serverId)) {
      throw new BadRequest("serverId must not repeat");
    }
    seen.add(server.serverId);
    return {
      serverId: server.serverId,
      read: server.read,
      write: server.write,
    };
  });
}

export function parseAgent(body: unknown): ParsedAgent {
  const b = fields(body, [
    "name",
    "avatar",
    "providerId",
    "model",
    "thinking",
    "effort",
    "prompt",
    "skills",
    "servers",
    "mcpMode",
    "contextLength",
    "tools",
    "upstream",
  ]);
  const name = parseAgentName(b.name);
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
  const servers = parseServers(b.servers);
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
  const stated =
    contextLength === null && b.tools === undefined
      ? null
      : { contextLength, tools: b.tools ?? false };
  return {
    name,
    avatar,
    providerId: b.providerId,
    model: b.model,
    thinking: b.thinking,
    effort: b.effort,
    prompt: prompt.trim(),
    skills,
    servers,
    mcpMode,
    upstream,
    stated,
  };
}
