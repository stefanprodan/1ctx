// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A request body, read with a cap and checked for shape. Every area's
// parsers start here: an object with exactly the fields it names, or
// a 400 naming the stranger.

import {
  isName,
  isRecord,
  MAX_MODEL,
  MAX_NAME,
  MIN_NAME,
  NAME_CHARACTERS,
} from "../../shared/words.ts";
import { BadRequest, PayloadTooLarge } from "./errors.ts";

export const MAX_BODY = 64 * 1024;
// Shared with the upload budget without making web depend on knowledge.
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

// a query of the allowed names, each at most once, read by name
export function queryParams(
  url: URL,
  allowed: readonly string[],
): (name: string) => string | null {
  const seen = new Set<string>();
  for (const name of url.searchParams.keys()) {
    if (!allowed.includes(name)) {
      throw new BadRequest(`unknown parameter ${name}`);
    }
    if (seen.has(name)) throw new BadRequest(`${name} must appear once`);
    seen.add(name);
  }
  return (name) => url.searchParams.get(name);
}

export function parseNoQuery(url: URL): void {
  queryParams(url, []);
}

// an object with exactly the given keys, or a 400 naming the stranger
export function fields(
  body: unknown,
  allowed: string[],
): Record<string, unknown> {
  if (!isRecord(body)) throw new BadRequest("body must be an object");
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new BadRequest(`unknown field ${key}`);
  }
  return body;
}

// an object's name, by the rule every named object shares
export function parseName(value: unknown, field = "name"): string {
  if (!isName(value)) {
    throw new BadRequest(
      `${field} must be ${MIN_NAME} to ${MAX_NAME} ${NAME_CHARACTERS}`,
    );
  }
  return value;
}

// a field's rule as a 400; null leaves the name to a caller that puts
// it in a path, as provision does
export function refusal(field: string | null, rule: string): BadRequest {
  return new BadRequest(field === null ? rule : `${field} ${rule}`);
}

// a provider's model id, as an agent or a decider names it
export function parseModel(value: unknown, field: string | null = "model") {
  if (typeof value !== "string" || value === "" || value.length > MAX_MODEL) {
    throw refusal(field, "must be a model id");
  }
  return value;
}

// a promise that rejects with the signal's reason once it aborts
export function raceSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolveRace, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolveRace(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

// a stream read to its end, or null past max bytes. Each read races the
// signal, and the cancel is awaited only to settle: an upload holds its
// slot until its body is let go, while a call's deadline must not wait
// on a cancel that hangs
export async function readStream(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  signal?: AbortSignal,
  settle = false,
): Promise<Uint8Array | null> {
  if (body === null) {
    signal?.throwIfAborted();
    return new Uint8Array();
  }
  const reader = body.getReader();
  let cancellation: Promise<unknown> | undefined;
  const cancel = (reason?: unknown) => {
    cancellation ??= reader.cancel(reason).catch(() => {});
  };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await (signal
        ? raceSignal(reader.read(), signal)
        : reader.read());
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > max) {
        cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    cancel(error);
    throw error;
  } finally {
    if (settle) await cancellation;
    reader.releaseLock();
  }
}

// a declared length is not trusted and an undeclared one cannot grow
// past the cap
export async function readBytes(
  req: Request,
  max = MAX_BODY,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) throw new PayloadTooLarge();
  const bytes = await readStream(req.body, max, signal, true);
  if (bytes === null) throw new PayloadTooLarge();
  return bytes;
}

export async function readBody(req: Request, max = MAX_BODY): Promise<string> {
  return new TextDecoder().decode(await readBytes(req, max));
}

export async function jsonBody(req: Request, max = MAX_BODY): Promise<unknown> {
  const text = await readBody(req, max);
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest("body must be JSON");
  }
}
