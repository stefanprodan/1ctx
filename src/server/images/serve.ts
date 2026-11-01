// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one answer for stored bytes. Called only after the access check:
// the 304 says the caller may still see the bytes, so a cache never
// outlives access, as a year of immutable did in a browser test.

import { contentDisposition } from "./names.ts";

export type Served = {
  mediaType: string;
  name: string;
  digest: string;
};

const etag = (digest: string) => `"${digest}"`;

// a list of tags, weak ones too, or the wildcard
export function matches(header: string | null, digest: string): boolean {
  if (header === null) return false;
  const tag = etag(digest);
  return header
    .split(",")
    .map((part) => part.trim().replace(/^W\//, ""))
    .some((part) => part === "*" || part === tag);
}

export function headersOf(file: Served): Headers {
  return new Headers({
    "cache-control": "private, no-cache",
    etag: etag(file.digest),
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin",
  });
}

// bytes read only when the tag does not match
export function serveBytes(
  req: Request,
  file: Served,
  data: () => Uint8Array<ArrayBuffer>,
): Response {
  const headers = headersOf(file);
  if (matches(req.headers.get("if-none-match"), file.digest)) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("content-type", file.mediaType);
  headers.set("content-disposition", contentDisposition(file.name));
  return new Response(data(), { headers });
}
