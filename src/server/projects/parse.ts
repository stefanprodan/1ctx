// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  AddMemberRequest,
  CreateProjectRequest,
  UpdateProjectRequest,
} from "../../shared/api/projects.ts";
import { isName, MAX_NAME, MIN_NAME } from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

function parseName(value: unknown): string {
  if (!isName(value)) {
    throw new BadRequest(
      `name must be ${MIN_NAME} to ${MAX_NAME} lowercase letters, digits and dashes`,
    );
  }
  return value;
}

export function parseCreateProject(body: unknown): CreateProjectRequest {
  const b = fields(body, ["name"]);
  return { name: parseName(b.name) };
}

export function parseUpdateProject(body: unknown): UpdateProjectRequest {
  const b = fields(body, ["name"]);
  return { name: parseName(b.name) };
}

export function parseAddMember(body: unknown): AddMemberRequest {
  const b = fields(body, ["userId"]);
  if (typeof b.userId !== "string" || b.userId === "") {
    throw new BadRequest("userId must be an id");
  }
  return { userId: b.userId };
}
