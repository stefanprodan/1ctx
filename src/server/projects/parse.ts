// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  AddMemberRequest,
  CreateLabelRequest,
  CreateProjectRequest,
  UpdateAboutRequest,
  UpdateLabelRequest,
  UpdateProjectRequest,
} from "../../shared/api/projects.ts";
import {
  DEFAULT_LABELS,
  isLabelDescription,
  isLabelName,
  LABEL_NAME_RULE,
  type LabelInput,
  MAX_LABEL_DESCRIPTION,
  MAX_LABELS_PER_PROJECT,
  shapeLabelName,
} from "../../shared/contracts/label.ts";
import {
  isDescription,
  isRecord,
  MAX_DESCRIPTION,
  type ProjectKind,
} from "../../shared/words.ts";
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

// trimmed and lowercased before the check, so `Build` saves as `build`
export function parseLabelName(value: unknown, field = "name"): string {
  const shaped = typeof value === "string" ? shapeLabelName(value) : value;
  if (!isLabelName(shaped)) {
    throw new BadRequest(`${field} must be ${LABEL_NAME_RULE}`);
  }
  return shaped;
}

export function parseLabelDescription(
  value: unknown,
  field = "description",
): string {
  if (!isLabelDescription(value)) {
    throw new BadRequest(
      `${field} must be one trimmed line of at most ${MAX_LABEL_DESCRIPTION} characters`,
    );
  }
  return value;
}

// a label's fields; `at` is its place in a list, empty for a whole body
function parseLabelInput(value: unknown, at = ""): Required<LabelInput> {
  if (at !== "" && !isRecord(value)) {
    throw new BadRequest(`${at} must be an object`);
  }
  const b = fields(value, ["name", "description"]);
  const field = (name: string) => (at === "" ? name : `${at}.${name}`);
  return {
    name: parseLabelName(b.name, field("name")),
    description:
      b.description === undefined
        ? ""
        : parseLabelDescription(b.description, field("description")),
  };
}

// a new project's labels: 1 to the cap, no name twice
function parseLabels(value: unknown): Required<LabelInput>[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_LABELS_PER_PROJECT
  ) {
    throw new BadRequest(
      `labels must be a list of 1 to ${MAX_LABELS_PER_PROJECT} labels`,
    );
  }
  const labels = value.map((item, i) => parseLabelInput(item, `labels.${i}`));
  const names = new Set(labels.map((label) => label.name));
  if (names.size !== labels.length) {
    throw new BadRequest("labels must not repeat a name");
  }
  return labels;
}

export function parseCreateProject(body: unknown): Required<
  Omit<CreateProjectRequest, "labels">
> & {
  labels: readonly Required<LabelInput>[];
} {
  const b = fields(body, ["name", "description", "labels"]);
  return {
    name: parseName(b.name),
    description: parseTeamDescription(b.description),
    labels: b.labels === undefined ? DEFAULT_LABELS : parseLabels(b.labels),
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

// a team project's description is required, a personal one's not
export function parseAbout(
  body: unknown,
  kind: ProjectKind,
): UpdateAboutRequest {
  const b = fields(body, ["description"]);
  return {
    description:
      kind === "team"
        ? parseTeamDescription(b.description)
        : parseDescription(b.description),
  };
}

export function parseCreateLabel(body: unknown): Required<CreateLabelRequest> {
  return parseLabelInput(body);
}

export function parseUpdateLabel(body: unknown): UpdateLabelRequest {
  const b = fields(body, ["name", "description"]);
  if (b.name === undefined && b.description === undefined) {
    throw new BadRequest("name or description is required");
  }
  return {
    ...(b.name === undefined ? {} : { name: parseLabelName(b.name) }),
    ...(b.description === undefined
      ? {}
      : { description: parseLabelDescription(b.description) }),
  };
}

export function parseAddMember(body: unknown): AddMemberRequest {
  const b = fields(body, ["userId"]);
  if (typeof b.userId !== "string" || b.userId === "") {
    throw new BadRequest("userId must be an id");
  }
  return { userId: b.userId };
}
