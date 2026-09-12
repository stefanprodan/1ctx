// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One JSON call to this server. An error body's message becomes the
// thrown error so a view can show it as is; the status rides on it so
// the caller can tell a 401 from the rest. Every 401 also fires the
// unauthorized hook, so a login revoked elsewhere drops the shell at
// once instead of leaving a stale signed-in page.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let unauthorized: () => void = () => {};

export function onUnauthorized(fn: () => void): void {
  unauthorized = fn;
}

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "the server did not answer");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401) unauthorized();
  if (!res.ok)
    throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data as T;
}
