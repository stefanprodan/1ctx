// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The provider request parsers: a new provider, and the catalog query.

import type { CreateProviderRequest } from "../../shared/api/providers.ts";
import {
  isName,
  isWire,
  MAX_NAME,
  MIN_NAME,
  NAME_CHARACTERS,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

export const MAX_BASE_URL = 256;
export const MAX_KEY_NAME = 64;
export const MAX_QUERY = 100;
// the same rule the secrets directory applies to a file's name, and the
// files that are the server's own, never a provider's key
const KEY_NAME_RE = /^[a-z][a-z0-9-]*$/;
export const RESERVED_KEYS = ["admin"];

export function parseName(value: unknown): string {
  if (!isName(value)) {
    throw new BadRequest(
      `name must be ${MIN_NAME} to ${MAX_NAME} ${NAME_CHARACTERS}`,
    );
  }
  return value;
}

// http or https, no query, no fragment, no trailing slash
export function parseBaseUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.length > MAX_BASE_URL
  ) {
    throw new BadRequest("baseUrl must be a URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequest("baseUrl must be a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BadRequest("baseUrl must be http or https");
  }
  if (
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new BadRequest("baseUrl must be a plain URL");
  }
  return value.replace(/\/+$/, "");
}

export function parseKeyName(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > MAX_KEY_NAME ||
    !KEY_NAME_RE.test(value)
  ) {
    throw new BadRequest(
      "keyName must be lowercase letters, digits and dashes, or null",
    );
  }
  if (RESERVED_KEYS.includes(value)) {
    throw new BadRequest(`${value}.key is not a provider key`);
  }
  return value;
}

export function parseProvider(body: unknown): CreateProviderRequest {
  const b = fields(body, ["name", "wire", "baseUrl", "keyName"]);
  if (!isWire(b.wire)) throw new BadRequest("wire must be a known wire");
  return {
    name: parseName(b.name),
    wire: b.wire,
    baseUrl: parseBaseUrl(b.baseUrl),
    keyName: parseKeyName(b.keyName ?? null),
  };
}

// ?q=: what was typed, trimmed; empty is allowed and matches nothing
export function parseQuery(url: URL): string {
  const q = url.searchParams.get("q") ?? "";
  if (q.length > MAX_QUERY) throw new BadRequest("q is too long");
  return q.trim();
}
