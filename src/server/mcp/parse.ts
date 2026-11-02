// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  CreateMcpRequest,
  McpProjects,
  PatchMcpEndpoint,
  PatchMcpRequest,
  PatchMcpSettings,
} from "../../shared/api/mcp.ts";
import {
  isPattern,
  isSecretName,
  isServerName,
  MAX_MCP_URL,
  MAX_PATTERNS,
  MCP_KEY_PREFIX,
  MCP_TIMEOUT_MS,
  secretNameRule,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

const CREATE_FIELDS = [
  "name",
  "url",
  "keyName",
  "read",
  "write",
  "instructionsOn",
  "timeoutMs",
  "readPatterns",
  "writePatterns",
  "excludedPatterns",
  "projects",
];
const SETTINGS_FIELDS = [
  "read",
  "write",
  "instructionsOn",
  "timeoutMs",
  "readPatterns",
  "writePatterns",
  "excludedPatterns",
];
const ENDPOINT_FIELDS = ["url", "keyName"];
// goes with either group
const SCOPE_FIELD = "projects";

// a row id, as lib/ids.ts makes them
const ID = /^[0-9a-z]{1,32}$/;
// more than any instance holds, so a list past it is a typo
const MAX_PROJECTS = 256;

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new BadRequest(`${name} must be true or false`);
  }
  return value;
}

export function parseMcpKeyName(value: unknown): string | null {
  if (value === null) return null;
  if (!isSecretName(MCP_KEY_PREFIX, value)) {
    throw new BadRequest(
      `keyName must be ${secretNameRule(MCP_KEY_PREFIX)}, or null`,
    );
  }
  return value;
}

export function parseUrl(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new BadRequest("url must be a URL");
  }
  if (value.length > MAX_MCP_URL) throw new BadRequest("url is too long");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequest("url must be a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BadRequest("url must be http or https");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new BadRequest("url must not have user info or a fragment");
  }
  return value;
}

// all, or distinct project ids; whether each is a team project is the
// route's to check against the rows
export function parseProjects(value: unknown): McpProjects {
  if (value === "all") return value;
  if (
    !Array.isArray(value) ||
    value.length > MAX_PROJECTS ||
    !value.every((id) => typeof id === "string" && ID.test(id)) ||
    new Set(value).size !== value.length
  ) {
    throw new BadRequest("projects must be all or distinct project ids");
  }
  return value as string[];
}

// a key acting for one owner never reaches everyone by accident, nor
// is it saved reaching no one
function keyedScope(
  keyName: string | null | undefined,
  projects: McpProjects | undefined,
): void {
  if (typeof keyName !== "string") return;
  if (projects !== undefined && projects !== "all" && projects.length === 0) {
    throw new BadRequest("a server with a key needs all or a project");
  }
}

export function parsePatterns(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new BadRequest(`${name} must be a list of patterns`);
  }
  if (value.length > MAX_PATTERNS) {
    throw new BadRequest(`${name} has too many patterns`);
  }
  const seen = new Set<string>();
  for (const pattern of value) {
    if (!isPattern(pattern)) {
      throw new BadRequest(`${name} has an invalid pattern`);
    }
    if (seen.has(pattern)) {
      throw new BadRequest(`${name} has a repeated pattern`);
    }
    seen.add(pattern);
  }
  return [...seen];
}

export function parseTimeout(value: unknown): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MCP_TIMEOUT_MS.min ||
    value > MCP_TIMEOUT_MS.max
  ) {
    throw new BadRequest(
      `timeoutMs must be ${MCP_TIMEOUT_MS.min} to ${MCP_TIMEOUT_MS.max}, or null`,
    );
  }
  return value;
}

const PATTERN_FIELDS = [
  "readPatterns",
  "writePatterns",
  "excludedPatterns",
] as const;

function patterns(
  b: Record<string, unknown>,
): Record<(typeof PATTERN_FIELDS)[number], string[]> {
  return {
    readPatterns: parsePatterns(b.readPatterns, "readPatterns"),
    writePatterns: parsePatterns(b.writePatterns, "writePatterns"),
    excludedPatterns: parsePatterns(b.excludedPatterns, "excludedPatterns"),
  };
}

export function parseCreate(body: unknown): CreateMcpRequest {
  const b = fields(body, CREATE_FIELDS);
  if (!isServerName(b.name)) throw new BadRequest("name is invalid");
  const keyName = parseMcpKeyName(b.keyName);
  if (keyName !== null && b.projects === undefined) {
    throw new BadRequest("a server with a key needs projects");
  }
  const projects = b.projects === undefined ? "all" : parseProjects(b.projects);
  keyedScope(keyName, projects);
  return {
    name: b.name,
    url: parseUrl(b.url),
    keyName,
    read: boolean(b.read, "read"),
    write: boolean(b.write, "write"),
    instructionsOn: boolean(b.instructionsOn, "instructionsOn"),
    timeoutMs: parseTimeout(b.timeoutMs),
    ...patterns(b),
    projects,
  };
}

export function parsePatch(body: unknown): PatchMcpRequest {
  const b = fields(body, [...SETTINGS_FIELDS, ...ENDPOINT_FIELDS, SCOPE_FIELD]);
  const keys = Object.keys(b);
  if (keys.length === 0) throw new BadRequest("patch must not be empty");
  const endpoint = keys.some((key) => ENDPOINT_FIELDS.includes(key));
  const settings = keys.some((key) => SETTINGS_FIELDS.includes(key));
  if (endpoint && settings) {
    throw new BadRequest("endpoint fields must be changed alone");
  }
  const projects = SCOPE_FIELD in b ? parseProjects(b[SCOPE_FIELD]) : undefined;
  const scope = projects === undefined ? {} : { projects };
  if (endpoint) {
    const out: PatchMcpEndpoint = { ...scope };
    if ("url" in b) out.url = parseUrl(b.url);
    if ("keyName" in b) out.keyName = parseMcpKeyName(b.keyName);
    keyedScope(out.keyName, projects);
    return out;
  }
  const out: PatchMcpSettings = { ...scope };
  if ("read" in b) out.read = boolean(b.read, "read");
  if ("write" in b) out.write = boolean(b.write, "write");
  if ("instructionsOn" in b) {
    out.instructionsOn = boolean(b.instructionsOn, "instructionsOn");
  }
  if ("timeoutMs" in b) out.timeoutMs = parseTimeout(b.timeoutMs);
  for (const field of PATTERN_FIELDS) {
    if (field in b) out[field] = parsePatterns(b[field], field);
  }
  return out;
}
