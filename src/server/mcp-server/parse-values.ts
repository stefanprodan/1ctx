// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { parseId } from "../knowledge/index.ts";
import { BadRequest } from "../lib/errors.ts";

export function requiredId(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    throw new BadRequest(`${field} is required`);
  }
  return parseId(value, field);
}

export function optionalId(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : parseId(value, field);
}

export function nonNegative(value: unknown, field: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BadRequest(`${field} must be a non-negative integer`);
  }
  return value;
}

export function positive(
  value: unknown,
  field: string,
  fallback: number | null,
): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new BadRequest(`${field} must be a positive integer`);
  }
  return value;
}

export function optionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new BadRequest(`${field} must be a boolean`);
  }
  return value;
}
