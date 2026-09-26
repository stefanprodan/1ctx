// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The provider request parsers: a new provider, the catalog query and
// the model whose endpoints are asked for.

import type { CreateProviderRequest } from "../../shared/api/providers.ts";
import {
  isName,
  isSecretName,
  isWire,
  MAX_NAME,
  MIN_NAME,
  NAME_CHARACTERS,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

export const MAX_BASE_URL = 256;
export const MAX_QUERY = 100;
// an agent's model id is capped the same
export const MAX_MODEL_ID = 200;

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
  if (!isSecretName("provider-", value)) {
    throw new BadRequest(
      "keyName must be provider- followed by 1 to 48 lowercase letters, " +
        "digits and dashes, starting with a letter or digit, or null",
    );
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

// ?model=: an OpenRouter id, author/slug with an optional :variant
export function parseModelQuery(url: URL): string {
  const model = url.searchParams.get("model") ?? "";
  // a segment never starts with a dot, so none walks up the path
  if (model.length > MAX_MODEL_ID || !/^~?\w[\w.-]*\/\w[\w.:-]*$/.test(model)) {
    throw new BadRequest("model must be an OpenRouter model id");
  }
  return model;
}
