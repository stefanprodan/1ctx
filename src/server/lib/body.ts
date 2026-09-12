// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A request body, read with a cap and checked for shape. Every area's
// parsers start here: an object with exactly the fields it names, or
// a 400 naming the stranger.

import { BadRequest, PayloadTooLarge } from "./errors.ts";

export const MAX_BODY = 64 * 1024;

// an object with exactly the given keys, or a 400 naming the stranger
export function fields(
  body: unknown,
  allowed: string[],
): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequest("body must be an object");
  }
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new BadRequest(`unknown field ${key}`);
  }
  return body as Record<string, unknown>;
}

// the body read chunk by chunk and dropped past the cap, so a declared
// length is not trusted and an undeclared one cannot grow unbounded
export async function readBody(req: Request, max = MAX_BODY): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) throw new PayloadTooLarge();
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new PayloadTooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function jsonBody(req: Request, max = MAX_BODY): Promise<unknown> {
  const text = await readBody(req, max);
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest("body must be JSON");
  }
}
