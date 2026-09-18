// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// JSON calls and byte uploads to this server. An error body's message
// becomes the thrown error so a view can show it as is; the status
// rides on it so the caller can tell a 401 from the rest. Every 401 also
// fires the unauthorized hook, so a login revoked elsewhere drops the
// shell at once instead of leaving a stale signed-in page. An answer without the
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

function responseFailure(status: number, body: unknown): ApiError {
  if (status === 401) unauthorized();
  const words =
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string" &&
    body.error.trim() !== ""
      ? body.error
      : statusWords(status);
  return new ApiError(status, words);
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
    throw responseFailure(0, null);
  }
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw responseFailure(res.status, data);
  return data as T;
}

export function upload<T>(
  path: string,
  body: Blob,
  {
    onProgress,
    signal,
  }: {
    onProgress?: (sent: number, total: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const aborted = () =>
      new DOMException("The operation was aborted.", "AbortError");
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      xhr.upload.onprogress = null;
      xhr.onload = null;
      xhr.onerror = null;
      xhr.ontimeout = null;
      xhr.onabort = null;
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const abort = () => {
      cleanup();
      xhr.abort();
      reject(aborted());
    };
    xhr.upload.onprogress = (event) => onProgress?.(event.loaded, event.total);
    xhr.onerror = () => fail(responseFailure(0, null));
    xhr.ontimeout = () => fail(responseFailure(0, null));
    xhr.onabort = () => fail(aborted());
    xhr.onload = () => {
      // A 401 can sign out and abort the uploader while handling this answer.
      cleanup();
      const ok = xhr.status >= 200 && xhr.status < 300;
      let data: unknown;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (error) {
        if (ok) {
          reject(error);
          return;
        }
      }
      if (ok) resolve(data as T);
      else reject(responseFailure(xhr.status, data));
    };
    try {
      xhr.open("POST", path, true);
      xhr.setRequestHeader("content-type", "application/octet-stream");
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      xhr.send(body);
    } catch (error) {
      fail(error);
    }
  });
}
