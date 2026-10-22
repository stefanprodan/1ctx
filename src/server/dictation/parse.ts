// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  PatchDictationRequest,
  PutDictationRequest,
} from "../../shared/api/dictation.ts";
import { DICTATION_CONTENT_TYPE } from "../../shared/contracts/dictation.ts";
import { fields, parseModel } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

export function parseDictation(body: unknown): PutDictationRequest {
  const b = fields(body, ["providerId", "model"]);
  if (typeof b.providerId !== "string" || b.providerId === "") {
    throw new BadRequest("providerId must be an id");
  }
  return { providerId: b.providerId, model: parseModel(b.model) };
}

export function parseDictationSwitch(body: unknown): PatchDictationRequest {
  const b = fields(body, ["enabled"]);
  if (typeof b.enabled !== "boolean") {
    throw new BadRequest("enabled must be a boolean");
  }
  return { enabled: b.enabled };
}

// the clip's type, parameters aside
export function parseClipType(header: string | null): void {
  const type = header?.split(";")[0]?.trim().toLowerCase();
  if (type !== DICTATION_CONTENT_TYPE) {
    throw new BadRequest(`the clip must be ${DICTATION_CONTENT_TYPE}`);
  }
}
