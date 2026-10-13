// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  CreateLabelRequest,
  UpdateLabelRequest,
} from "../../../shared/api/projects.ts";
import {
  DEFAULT_LABELS,
  isLabelName,
  type LabelInput,
  MAX_LABELS_PER_PROJECT,
  type ProjectLabel,
  shapeLabelName,
} from "../../../shared/contracts/label.ts";
import { plural } from "../../lib/format.ts";
import { at, type Problem } from "../../lib/save.ts";

export const LABELS_TEXT = "How work here is sorted.";
export const CAP_LINE = `At most ${MAX_LABELS_PER_PROJECT} labels.`;
export const LAST_LINE = "A project keeps at least one label.";
// the delete ask says how many tasks the label comes off, closed too
export function deleteAsk(tasks: number): string {
  if (tasks === 0) return "Delete this label?";
  return `Delete this label? ${plural(tasks, "task")} ${tasks === 1 ? "uses" : "use"} it.`;
}

export type OpenLabel = ProjectLabel | "new" | null;
export type LabelDraft = { name: string; description: string };

// a row gone from the list, deleted in another tab, closes its form
export function openOf(
  open: OpenLabel,
  list: readonly ProjectLabel[],
): OpenLabel {
  if (open === null || open === "new") return open;
  return list.some((l) => l.id === open.id) ? open : null;
}

// what the edit form's foot offers; a delete asked for gives way to the
// hint once a refresh makes its label the project's last
export type LabelFoot = "add" | "delete" | "asking" | "last";
export function footOf(
  row: ProjectLabel | null,
  last: boolean,
  asking: boolean,
): LabelFoot {
  if (row === null) return "add";
  if (last) return "last";
  return asking ? "asking" : "delete";
}

export const atCap = (list: readonly ProjectLabel[]) =>
  list.length >= MAX_LABELS_PER_PROJECT;

export const draftOf = (row: ProjectLabel | null): LabelDraft => ({
  name: row?.name ?? "",
  description: row?.description ?? "",
});

// the name as the server saves it, so `Build` against `build` is no change
export function createBody(d: LabelDraft): CreateLabelRequest {
  const description = d.description.trim();
  return {
    name: shapeLabelName(d.name),
    ...(description === "" ? {} : { description }),
  };
}

// only what changed against the row the form opened on
export function patchBody(
  d: LabelDraft,
  row: ProjectLabel,
): UpdateLabelRequest | null {
  const body: UpdateLabelRequest = {};
  const name = shapeLabelName(d.name);
  if (name !== row.name) body.name = name;
  const description = d.description.trim();
  if (description !== row.description) body.description = description;
  return Object.keys(body).length === 0 ? null : body;
}

export function labelFieldOf(message: string): string | undefined {
  if (message.startsWith("name")) return "name";
  if (message.startsWith("description")) return "description";
  return undefined;
}

// the admin's create form: the defaults, filled in and editable; the
// key keeps a row's inputs when one above it is removed
export type NewLabel = LabelDraft & { key: number };

export const defaultDrafts = (): NewLabel[] =>
  DEFAULT_LABELS.map((label, key) => ({ ...label, key }));

export const LABEL_NAME_PROBLEM =
  "Use 1 to 24 lowercase letters, digits and dashes";
export const LABEL_REPEAT_PROBLEM = "This name is used above";

// the first draft the server would refuse, at its input, so the words
// are the form's own and not the API's field path
export function labelsProblem(drafts: readonly LabelDraft[]): Problem | null {
  const seen = new Set<string>();
  for (const [i, d] of drafts.entries()) {
    const name = shapeLabelName(d.name);
    const field = `labels.${i}.name`;
    if (!isLabelName(name)) return at(field, LABEL_NAME_PROBLEM);
    if (seen.has(name)) return at(field, LABEL_REPEAT_PROBLEM);
    seen.add(name);
  }
  return null;
}

// the Settings form's name, refused in the same words as the create form's
export const labelNameProblem = (d: LabelDraft): Problem | null =>
  isLabelName(shapeLabelName(d.name)) ? null : at("name", LABEL_NAME_PROBLEM);

export function labelsBody(drafts: readonly NewLabel[]): LabelInput[] {
  return drafts.map((d) => createBody(d));
}
