// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One JSON call to this server. An error body's message becomes the
// thrown error so a view can show it as is; the status rides on it so
// the caller can tell a 401 from the rest. Every 401 also fires the
// unauthorized hook, so a login revoked elsewhere drops the shell at
// once instead of leaving a stale signed-in page. An answer without the
// server's words, a crash or a proxy's page, gets plain words for its
// status, never the status code.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// the words for an answer that carries none of the server's own
export function statusWords(status: number): string {
  if (status === 0) return "the server did not answer";
  if (status === 403) return "you do not have access to this";
  if (status === 404) return "this is no longer there";
  if (status === 413) return "this is too large to send";
  if (status === 429) return "too many requests. Wait a moment and try again";
  if (status >= 500) {
    return "the server failed while answering. Contact the admin if this error persists";
  }
  return "the server refused this";
}

let unauthorized: () => void = () => {};

export function onUnauthorized(fn: () => void): void {
  unauthorized = fn;
}

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      signal,
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    signal?.throwIfAborted();
    throw new ApiError(0, statusWords(0));
  }
  const data = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (res.status === 401) unauthorized();
  if (!res.ok) {
    const words =
      typeof data.error === "string" && data.error.trim() !== ""
        ? data.error
        : statusWords(res.status);
    throw new ApiError(res.status, words);
  }
  return data as T;
}
