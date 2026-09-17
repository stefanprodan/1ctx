// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { BadRequest } from "../lib/errors.ts";

export function object(
  value: unknown,
  allowed: readonly string[],
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path || "document"} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${path ? `${path}.` : ""}${key} is an unknown field`);
    }
  }
  return value as Record<string, unknown>;
}

export function at<T>(path: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof BadRequest) {
      throw new Error(`${path}: ${error.message}`);
    }
    throw error;
  }
}

export function optional<T>(
  body: Record<string, unknown>,
  validators: { [K in keyof Required<T>]: (value: unknown) => T[K] },
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(validators) as (keyof T & string)[]) {
    if (Object.hasOwn(body, key)) {
      out[key] = at(`spec.${key}`, () => validators[key](body[key]));
    }
  }
  return out;
}

export function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new BadRequest("must be true or false");
  }
  return value;
}

export function guarded<T>(
  guard: (value: unknown) => value is T,
  message: string,
): (value: unknown) => T {
  return (value) => {
    if (!guard(value)) throw new BadRequest(message);
    return value;
  };
}

export function names(
  value: unknown,
  guard: (value: unknown) => value is string,
  cap?: number,
): string[] {
  if (!Array.isArray(value)) throw new BadRequest("must be an array of names");
  if (cap !== undefined && value.length > cap) {
    throw new BadRequest(`must have at most ${cap} names`);
  }
  const seen = new Set<string>();
  for (const name of value) {
    if (!guard(name)) throw new BadRequest("has an invalid name");
    if (seen.has(name)) throw new BadRequest(`name ${name} must not repeat`);
    seen.add(name);
  }
  return [...seen];
}
