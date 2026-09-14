// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  AddMemberRequest,
  CreateProjectRequest,
  UpdateProjectRequest,
} from "../../shared/api/projects.ts";
import {
  isDescription,
  isName,
  MAX_DESCRIPTION,
  MAX_NAME,
  MIN_NAME,
} from "../../shared/words.ts";
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

function parseDescription(value: unknown): string {
  if (!isDescription(value)) {
    throw new BadRequest(
      `description must be one trimmed line of at most ${MAX_DESCRIPTION} characters`,
    );
  }
  return value;
}

export function parseCreateProject(
  body: unknown,
): Required<CreateProjectRequest> {
  const b = fields(body, ["name", "description"]);
  return {
    name: parseName(b.name),
    description:
      b.description === undefined ? "" : parseDescription(b.description),
  };
}

export function parseUpdateProject(body: unknown): UpdateProjectRequest {
  const b = fields(body, ["name", "description"]);
  if (b.name === undefined && b.description === undefined) {
    throw new BadRequest("name or description is required");
  }
  return {
    ...(b.name === undefined ? {} : { name: parseName(b.name) }),
    ...(b.description === undefined
      ? {}
      : { description: parseDescription(b.description) }),
  };
}

export function parseAddMember(body: unknown): AddMemberRequest {
  const b = fields(body, ["userId"]);
  if (typeof b.userId !== "string" || b.userId === "") {
    throw new BadRequest("userId must be an id");
  }
  return { userId: b.userId };
}
