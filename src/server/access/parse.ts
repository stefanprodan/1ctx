// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The request parsers of the access routes. A shared type checks the
// source; these check the JSON a stale tab or a hostile client sends,
// and refuse anything unexpected with a 400. The body is capped before
// it is read, so a public route buffers at most MAX_BODY bytes.

import type { LoginRequest } from "../../shared/api/access.ts";
import { BadRequest, PayloadTooLarge } from "../lib/errors.ts";
import { MAX_PASSWORD_BYTES } from "../users/index.ts";

export const MAX_NAME = 64;
export const MAX_BODY = 64 * 1024;

const bytes = (s: string) => new TextEncoder().encode(s).length;

export function parseLogin(body: unknown): LoginRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequest("body must be an object");
  }
  const keys = Object.keys(body);
  for (const key of keys) {
    if (key !== "name" && key !== "password") {
      throw new BadRequest(`unknown field ${key}`);
    }
  }
  const { name, password } = body as Record<string, unknown>;
  if (typeof name !== "string" || name === "" || name.length > MAX_NAME) {
    throw new BadRequest(
      `name must be a string of 1 to ${MAX_NAME} characters`,
    );
  }
  if (
    typeof password !== "string" ||
    password === "" ||
    bytes(password) > MAX_PASSWORD_BYTES
  ) {
    throw new BadRequest(
      `password must be a string of 1 to ${MAX_PASSWORD_BYTES} bytes`,
    );
  }
  return { name, password };
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
