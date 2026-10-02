// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The API's answer for a ref: the commit it points at now. GitHub's
// sha media type answers the bare id, GitLab's commit its JSON; both
// take the last ETag and answer 304 when the ref has not moved.

import type { RepoError } from "../../shared/contracts/repo.ts";
import { type Adapter, isCommit } from "./adapters.ts";
import type { RepoHeader } from "./check.ts";
import { REPO_LOOKUP_BYTES, REPO_LOOKUP_DEADLINE_MS } from "./limits.ts";
import { follow } from "./redirect.ts";

export type Looked =
  | { ok: true; commit: string | null; etag: string | null }
  | { ok: false; error: RepoError; status: number | null };

async function capped(response: Response): Promise<string | null> {
  if (response.body === null) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > REPO_LOOKUP_BYTES) return null;
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function commitOf(text: string): string | null {
  const trimmed = text.trim();
  if (isCommit(trimmed)) return trimmed;
  try {
    const body = JSON.parse(trimmed) as { id?: unknown; sha?: unknown };
    const id = body.id ?? body.sha;
    return typeof id === "string" && isCommit(id) ? id : null;
  } catch {
    return null;
  }
}

// commit null on a 304: the ref is where the ETag's answer left it
export async function apiLookup(
  fetcher: typeof fetch,
  adapter: Adapter,
  ref: string,
  header: RepoHeader | null,
  etag: string | null,
  userAgent: string,
): Promise<Looked> {
  const headers: Record<string, string> = {
    ...adapter.lookupHeaders,
    "user-agent": userAgent,
  };
  if (etag !== null) headers["if-none-match"] = etag;
  const followed = await follow(
    fetcher,
    adapter.lookupUrl(ref),
    headers,
    header,
    AbortSignal.timeout(REPO_LOOKUP_DEADLINE_MS),
  );
  if (!followed.ok) return followed;
  const response = followed.response;
  const status = response.status;
  if (status === 304 && etag !== null) {
    await response.body?.cancel().catch(() => {});
    return { ok: true, commit: null, etag };
  }
  if (status !== 200) {
    await response.body?.cancel().catch(() => {});
    if (status === 404 || status === 410 || status === 422) {
      return { ok: false, error: "not found", status };
    }
    if (status === 401 || status === 403) {
      return { ok: false, error: "no access", status };
    }
    return { ok: false, error: "host unreachable", status };
  }
  let text: string | null;
  try {
    text = await capped(response);
  } catch {
    return { ok: false, error: "host unreachable", status };
  }
  const commit = text === null ? null : commitOf(text);
  if (commit === null) return { ok: false, error: "host unreachable", status };
  return { ok: true, commit, etag: response.headers.get("etag") };
}
