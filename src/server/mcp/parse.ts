// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  CreateMcpRequest,
  PatchMcpEndpoint,
  PatchMcpRequest,
  PatchMcpSettings,
} from "../../shared/api/mcp.ts";
import {
  isPattern,
  isServerName,
  MAX_MCP_URL,
  MAX_PATTERNS,
  MCP_KEY_PREFIX,
  MCP_TIMEOUT_MS,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import { parseKeyName } from "../providers/index.ts";

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

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new BadRequest(`${name} must be true or false`);
  }
  return value;
}

// a provider's key rule, and then the prefix: an MCP key file is
// mcp-<name>.key, so the form can list them and nothing else is picked
export function parseMcpKeyName(value: unknown): string | null {
  const name = parseKeyName(value);
  if (name !== null && !name.startsWith(MCP_KEY_PREFIX)) {
    throw new BadRequest(`keyName must start with ${MCP_KEY_PREFIX}`);
  }
  return name;
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

function patterns(b: Record<string, unknown>) {
  return {
    readPatterns: parsePatterns(b.readPatterns, "readPatterns"),
    writePatterns: parsePatterns(b.writePatterns, "writePatterns"),
    excludedPatterns: parsePatterns(b.excludedPatterns, "excludedPatterns"),
  };
}

export function parseCreate(body: unknown): CreateMcpRequest {
  const b = fields(body, CREATE_FIELDS);
  if (!isServerName(b.name)) throw new BadRequest("name is invalid");
  return {
    name: b.name,
    url: parseUrl(b.url),
    keyName: parseMcpKeyName(b.keyName),
    read: boolean(b.read, "read"),
    write: boolean(b.write, "write"),
    instructionsOn: boolean(b.instructionsOn, "instructionsOn"),
    timeoutMs: parseTimeout(b.timeoutMs),
    ...patterns(b),
  };
}

export function parsePatch(body: unknown): PatchMcpRequest {
  const b = fields(body, [...SETTINGS_FIELDS, ...ENDPOINT_FIELDS]);
  const keys = Object.keys(b);
  if (keys.length === 0) throw new BadRequest("patch must not be empty");
  const endpoint = keys.some((key) => ENDPOINT_FIELDS.includes(key));
  const settings = keys.some((key) => SETTINGS_FIELDS.includes(key));
  if (endpoint && settings) {
    throw new BadRequest("endpoint fields must be changed alone");
  }
  if (endpoint) {
    const out: PatchMcpEndpoint = {};
    if ("url" in b) out.url = parseUrl(b.url);
    if ("keyName" in b) out.keyName = parseMcpKeyName(b.keyName);
    return out;
  }
  const out: PatchMcpSettings = {};
  if ("read" in b) out.read = boolean(b.read, "read");
  if ("write" in b) out.write = boolean(b.write, "write");
  if ("instructionsOn" in b) {
    out.instructionsOn = boolean(b.instructionsOn, "instructionsOn");
  }
  if ("timeoutMs" in b) out.timeoutMs = parseTimeout(b.timeoutMs);
  if ("readPatterns" in b) {
    out.readPatterns = parsePatterns(b.readPatterns, "readPatterns");
  }
  if ("writePatterns" in b) {
    out.writePatterns = parsePatterns(b.writePatterns, "writePatterns");
  }
  if ("excludedPatterns" in b) {
    out.excludedPatterns = parsePatterns(
      b.excludedPatterns,
      "excludedPatterns",
    );
  }
  return out;
}
