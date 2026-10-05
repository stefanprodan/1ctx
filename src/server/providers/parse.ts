// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { CreateProviderRequest } from "../../shared/api/providers.ts";
import {
  CATALOG_KINDS,
  type CatalogKind,
  isCatalogKind,
} from "../../shared/contracts/decider.ts";
import { isSecretName, isWire, MAX_MODEL } from "../../shared/words.ts";
import { fields, parseName, queryParams } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import { azureBaseUrlProblem } from "./azure.ts";

const MAX_BASE_URL = 256;
const MAX_QUERY = 100;

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
  const baseUrl = parseBaseUrl(b.baseUrl);
  const problem = b.wire === "azure" ? azureBaseUrlProblem(baseUrl) : null;
  if (problem !== null) throw new BadRequest(`baseUrl ${problem}`);
  return {
    name: parseName(b.name),
    wire: b.wire,
    baseUrl,
    keyName: parseKeyName(b.keyName ?? null),
  };
}

// ?q=&kind=: what was typed, trimmed, where empty is allowed and
// matches nothing, and which catalog to search, the chat models when absent
export function parseCatalogQuery(url: URL): { q: string; kind: CatalogKind } {
  const get = queryParams(url, ["q", "kind"]);
  const q = get("q") ?? "";
  if (q.length > MAX_QUERY) throw new BadRequest("q is too long");
  const kind = get("kind") ?? "chat";
  if (!isCatalogKind(kind)) {
    throw new BadRequest(`kind must be ${CATALOG_KINDS.join(" or ")}`);
  }
  return { q: q.trim(), kind };
}

// ?model=: an OpenRouter id, author/slug with an optional :variant
export function parseModelQuery(url: URL): string {
  const model = queryParams(url, ["model"])("model") ?? "";
  // a segment never starts with a dot, so none walks up the path
  if (model.length > MAX_MODEL || !/^~?\w[\w.-]*\/\w[\w.:-]*$/.test(model)) {
    throw new BadRequest("model must be an OpenRouter model id");
  }
  return model;
}
