// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A repository's requests, redirects followed by hand: https only, no
// userinfo, at most MAX_HOPS, and the key's header sent only under the
// API base and never again after the first hop off it. GitHub's
// tarball answers a redirect to codeload whose location carries its own
// token, so a location is never logged or put in an error.

import type { RepoError } from "../../shared/contracts/repo.ts";
import { covers } from "./adapters.ts";
import type { RepoHeader } from "./check.ts";

export const MAX_HOPS = 3;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export type Followed =
  | { ok: true; response: Response }
  | { ok: false; error: RepoError; status: number | null };

// the closed word for a host's answer that is not a tree
export function statusError(status: number): RepoError {
  if (status === 404 || status === 410) return "not found";
  if (status === 401 || status === 403) return "no access";
  return "host unreachable";
}

function allowed(url: URL): boolean {
  return url.protocol === "https:" && url.username === "" && !url.password;
}

export async function follow(
  fetcher: typeof fetch,
  start: string,
  headers: Record<string, string>,
  header: RepoHeader | null,
  signal: AbortSignal,
): Promise<Followed> {
  let url: URL;
  try {
    url = new URL(start);
  } catch {
    return { ok: false, error: "host unreachable", status: null };
  }
  let signing = header !== null;
  let status: number | null = null;
  for (let hop = 0; ; hop++) {
    if (!allowed(url)) return { ok: false, error: "host unreachable", status };
    signing = signing && covers(header!.prefix, url.href);
    const sent = signing
      ? { ...headers, [header!.name]: header!.value }
      : headers;
    let response: Response;
    try {
      response = await fetcher(url.href, {
        headers: sent,
        redirect: "manual",
        signal,
      });
    } catch {
      return { ok: false, error: "host unreachable", status: null };
    }
    if (!REDIRECTS.has(response.status)) return { ok: true, response };
    status = response.status;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {});
    if (location === null || hop + 1 > MAX_HOPS) {
      return { ok: false, error: "host unreachable", status };
    }
    try {
      url = new URL(location, url);
    } catch {
      return { ok: false, error: "host unreachable", status };
    }
  }
}
