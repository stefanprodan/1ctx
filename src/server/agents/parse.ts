// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agent request parser: a name, a provider id and a model id. That
// the provider exists and the catalog lists the model is the route's
// check, not the parser's.

import type { SaveAgentRequest } from "../../shared/api/agents.ts";
import { isName, MAX_NAME, MIN_NAME } from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

export const MAX_MODEL = 200;

export function parseAgent(body: unknown): SaveAgentRequest {
  const b = fields(body, ["name", "providerId", "model"]);
  if (!isName(b.name)) {
    throw new BadRequest(
      `name must be ${MIN_NAME} to ${MAX_NAME} lowercase letters, digits and dashes`,
    );
  }
  if (typeof b.providerId !== "string" || b.providerId === "") {
    throw new BadRequest("providerId must be an id");
  }
  if (
    typeof b.model !== "string" ||
    b.model === "" ||
    b.model.length > MAX_MODEL
  ) {
    throw new BadRequest("model must be a model id");
  }
  return { name: b.name, providerId: b.providerId, model: b.model };
}
