// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Row ids and tokens. An id is short and URL-safe; a token is long and
// only ever stored hashed.

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function newId(length = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

// 32 random bytes as base64url, the value a cookie carries
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
