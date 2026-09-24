// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An HTTP credential as the wire exposes it: a key file an admin put in
// the secrets directory, the one https prefix bash's curl signs with it,
// the header it goes in and the team projects it is bound to. The key's
// value never rides here; only whether its file is there and usable.

export const MAX_CREDENTIALS_PER_PROJECT = 10;

export const HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
export const DEFAULT_METHODS: HttpMethod[] = ["GET", "HEAD"];

export function isHttpMethod(value: unknown): value is HttpMethod {
  return HTTP_METHODS.includes(value as HttpMethod);
}

// where the key goes in the header's value, exactly once
export const KEY_PLACEHOLDER = "{key}";
export const MAX_PREFIX = 512;
export const MAX_HEADER_NAME = 128;
export const MAX_TEMPLATE = 256;
// the key's own bytes, each visible ASCII
export const KEY_BYTES = { min: 16, max: 4096 } as const;

// ok, no file, or a file that is empty or fails the key's rule
export type KeyState = "ok" | "missing" | "unusable";

export type CredentialSummary = {
  id: string;
  name: string;
  keyName: string;
  key: KeyState;
  // canonical: the https origin and the path, never a query
  prefix: string;
  header: string;
  template: string;
  methods: HttpMethod[];
  // the team projects it is bound to, in name order
  projects: { id: string; name: string }[];
  createdAt: number;
  updatedAt: number;
};
