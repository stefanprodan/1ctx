// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's labels: the words its users sort work by, held on the
// project so every item picks from one list. Users write them; agents
// only read them.

import { hasLineBreak } from "../words.ts";

// what an agent reads of them stays small, and a picker shows them all
export const MAX_LABELS_PER_PROJECT = 20;
export const MAX_LABEL_NAME = 24;
export const MAX_LABEL_DESCRIPTION = 100;

export type ProjectLabel = {
  id: string;
  name: string;
  // empty for none
  description: string;
};

// a label as a create names it, before it has an id
export type LabelInput = { name: string; description?: string };

// every new project starts with these; they name the kind of work, not
// the field, so they fit any project
export const DEFAULT_LABELS: readonly Required<LabelInput>[] = [
  {
    name: "research",
    description: "Investigation or analysis, no change made",
  },
  { name: "plan", description: "A proposal or design to decide on" },
  { name: "build", description: "New work or a change to existing work" },
  { name: "fix", description: "A defect or failure to correct" },
];

const LABEL_NAME_RE = new RegExp(
  `^[a-z0-9][a-z0-9-]{0,${MAX_LABEL_NAME - 1}}$`,
);

export const LABEL_NAME_RULE = `1 to ${MAX_LABEL_NAME} lowercase letters, digits and -, starting with a letter or digit`;

// typed text as it is saved: `Build ` saves as `build`
export const shapeLabelName = (value: string) => value.trim().toLowerCase();

export function isLabelName(value: unknown): value is string {
  return typeof value === "string" && LABEL_NAME_RE.test(value);
}

// one trimmed line, empty for none
export function isLabelDescription(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_LABEL_DESCRIPTION &&
    value === value.trim() &&
    !hasLineBreak(value)
  );
}
