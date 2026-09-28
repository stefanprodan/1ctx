// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { PutLimitsRequest } from "../../shared/api/limits.ts";
import { LIMIT_NAMES } from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import { LIMIT_DEFINITIONS } from "./defaults.ts";

export function parseLimits(body: unknown): PutLimitsRequest {
  const outer = fields(body, ["values"]);
  const input = fields(outer.values, [...LIMIT_NAMES]);
  const values: PutLimitsRequest["values"] = {};
  for (const name of LIMIT_NAMES) {
    if (!(name in input)) continue;
    const value = input[name];
    const entry = LIMIT_DEFINITIONS[name];
    if (!Number.isInteger(value)) {
      throw new BadRequest(`${name} must be an integer`);
    }
    if ((value as number) < entry.min || (value as number) > entry.max) {
      throw new BadRequest(
        `${name} must be between ${entry.min} and ${entry.max}`,
      );
    }
    values[name] = value as number;
  }
  if (Object.keys(values).length === 0) {
    throw new BadRequest("values must name a limit");
  }
  return { values };
}
