// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  AddMemberRequest,
  CreateProjectRequest,
  UpdatePersonalProjectRequest,
  UpdateProjectRequest,
} from "../../shared/api/projects.ts";
import { isDescription, MAX_DESCRIPTION } from "../../shared/words.ts";
import { fields, parseName } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

function parseDescription(value: unknown): string {
  if (!isDescription(value)) {
    throw new BadRequest(
      `description must be one trimmed line of at most ${MAX_DESCRIPTION} characters`,
    );
  }
  return value;
}

function parseTeamDescription(value: unknown): string {
  if (value === undefined || value === "") {
    throw new BadRequest("description is required");
  }
  return parseDescription(value);
}

export function parseCreateProject(
  body: unknown,
): Required<CreateProjectRequest> {
  const b = fields(body, ["name", "description"]);
  return {
    name: parseName(b.name),
    description: parseTeamDescription(b.description),
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
      : { description: parseTeamDescription(b.description) }),
  };
}

// a personal project is always named personal; its owner describes it
export function parseUpdatePersonalProject(
  body: unknown,
): UpdatePersonalProjectRequest {
  const b = fields(body, ["description"]);
  return { description: parseDescription(b.description) };
}

export function parseAddMember(body: unknown): AddMemberRequest {
  const b = fields(body, ["userId"]);
  if (typeof b.userId !== "string" || b.userId === "") {
    throw new BadRequest("userId must be an id");
  }
  return { userId: b.userId };
}
