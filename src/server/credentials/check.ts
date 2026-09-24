// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rules a credential is held to, pure: at save, in provisioning's
// preflight, and again at each command that would sign a request.

import { matchesAllowListEntry, validateAllowList } from "just-bash";
import {
  KEY_BYTES,
  KEY_PLACEHOLDER,
  MAX_HEADER_NAME,
  MAX_PREFIX,
  MAX_TEMPLATE,
} from "../../shared/contracts/credential.ts";

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const refused = (error: string) => ({ ok: false, error }) as const;

// https alone, never userinfo, a query or a fragment; stored as the
// parsed origin and path, the host without a trailing dot
export function normalizePrefix(value: unknown): Checked<string> {
  if (typeof value !== "string" || value === "" || value.length > MAX_PREFIX) {
    return refused(`prefix must be a URL of at most ${MAX_PREFIX} characters`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refused("prefix must be a URL");
  }
  if (url.protocol !== "https:") return refused("prefix must be https");
  if (url.username !== "" || url.password !== "") {
    return refused("prefix must not hold a user or a password");
  }
  // an empty "?" or "#" parses away, so the text says whether one was typed
  if (url.search !== "" || url.hash !== "" || /[?#]/.test(value)) {
    return refused("prefix must not hold a query or a fragment");
  }
  const host = url.hostname.replace(/\.$/, "");
  if (host === "" || host.endsWith(".")) {
    return refused("prefix must name a host");
  }
  url.hostname = host;
  const prefix = `${url.origin}${url.pathname}`;
  if (prefix.length > MAX_PREFIX || validateAllowList([prefix]).length > 0) {
    return refused("prefix is not a usable URL prefix");
  }
  return { ok: true, value: prefix };
}

// a request one could send to both: either matches the other, since a
// prefix is itself a URL under its own path
export function prefixesOverlap(a: string, b: string): boolean {
  return matchesAllowListEntry(a, b) || matchesAllowListEntry(b, a);
}

// RFC 9110's token
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// what the transport owns, or what would reframe the request
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
]);

export function checkHeaderName(value: unknown): Checked<string> {
  if (
    typeof value !== "string" ||
    value.length > MAX_HEADER_NAME ||
    !TOKEN.test(value)
  ) {
    return refused(
      `header must be a header name of at most ${MAX_HEADER_NAME} characters`,
    );
  }
  const folded = value.toLowerCase();
  if (FORBIDDEN_HEADERS.has(folded) || folded.startsWith("proxy-")) {
    return refused(`header ${value} cannot carry a key`);
  }
  return { ok: true, value };
}

// printable ASCII and the space, the key's place exactly once
export function checkTemplate(value: unknown): Checked<string> {
  if (
    typeof value !== "string" ||
    value.length > MAX_TEMPLATE ||
    !/^[\x20-\x7e]*$/.test(value)
  ) {
    return refused(
      `template must be at most ${MAX_TEMPLATE} printable ASCII characters`,
    );
  }
  if (value.split(KEY_PLACEHOLDER).length !== 2) {
    return refused(`template must hold ${KEY_PLACEHOLDER} exactly once`);
  }
  return { ok: true, value };
}

// the key's own rule: visible ASCII, so its length is its bytes
export function isUsableKey(value: string): boolean {
  return (
    value.length >= KEY_BYTES.min &&
    value.length <= KEY_BYTES.max &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

// the header's value for a key the rules passed
export function headerValue(template: string, key: string): string {
  return template.replace(KEY_PLACEHOLDER, () => key);
}
