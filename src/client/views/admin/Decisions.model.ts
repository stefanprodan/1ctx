// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SaveDecisionRequest } from "../../../shared/api/decisions.ts";
import type { DeciderSummary } from "../../../shared/contracts/decider.ts";
import {
  type DecisionId,
  type DecisionSummary,
  MAX_OPTION_TEXT,
} from "../../../shared/contracts/decision.ts";
import { commas } from "../../lib/format.ts";
import type { IconName } from "../../lib/icons.tsx";
import type { Option } from "../../ui/Select.model.ts";

export type DecisionWords = {
  title: string;
  sub: string;
  hint: string;
  icon: IconName;
  labels: Record<string, string>;
};

export const DECISION_WORDS: Record<DecisionId, DecisionWords> = {
  "run-attention": {
    title: "Mark task runs that need attention",
    sub: "Reads each finished task run",
    hint: "The decider reads the answer of each finished task run and marks the run when it fits Needs attention.",
    icon: "decision",
    labels: {
      "all-good": "All good when",
      "needs-attention": "Needs attention when",
    },
  },
};

export const byTitle = (list: readonly DecisionSummary[]): DecisionSummary[] =>
  list
    .slice()
    .sort((a, b) =>
      DECISION_WORDS[a.id].title.localeCompare(DECISION_WORDS[b.id].title),
    );

export const optionLabel = (id: DecisionId, key: string): string =>
  DECISION_WORDS[id].labels[key] ?? key;

export const isCustom = (d: DecisionSummary): boolean =>
  d.options.some((o) => o.description !== o.default);

const defaultName = (list: DeciderSummary[]): string | undefined =>
  list.find((d) => d.default)?.name;

// a named decider gone falls back on the default, as the server does;
// with no deciders nothing is asked, whatever the switch says
export function decisionMeta(
  d: DecisionSummary,
  list: DeciderSummary[],
): { long: string; short: string } {
  if (list.length === 0) {
    return { long: "off until a decider is added", short: "off" };
  }
  const state = d.enabled ? "on" : "off";
  const who = d.enabled
    ? (list.find((x) => x.id === d.deciderId)?.name ?? defaultName(list) ?? "")
    : "";
  const mark = isCustom(d) ? "custom" : "";
  const short = [state, who].filter((s) => s !== "").join(" · ");
  return { long: mark === "" ? short : `${short} · ${mark}`, short };
}

// "" stands for the default
export function deciderChoices(list: DeciderSummary[]): Option[] {
  const name = defaultName(list);
  return [
    { value: "", label: name ? `Default (${name})` : "Default" },
    ...list.map((d) => ({ value: d.id, label: d.name })),
  ];
}

// a decider may be deleted on the same page
export const heldDecider = (list: DeciderSummary[], picked: string): string =>
  list.some((d) => d.id === picked) ? picked : "";

export function decisionBody(
  d: DecisionSummary,
  form: { enabled: boolean; deciderId: string; texts: Record<string, string> },
): SaveDecisionRequest {
  return {
    enabled: form.enabled,
    deciderId: form.deciderId === "" ? null : form.deciderId,
    options: Object.fromEntries(
      d.options.map((o) => [o.key, (form.texts[o.key] ?? "").trim()]),
    ),
  };
}

export const defaultTexts = (d: DecisionSummary): Record<string, string> =>
  Object.fromEntries(d.options.map((o) => [o.key, o.default]));

export const differsFromDefault = (
  d: DecisionSummary,
  texts: Record<string, string>,
): boolean => d.options.some((o) => (texts[o.key] ?? "").trim() !== o.default);

export const optionField = (key: string): string => `options.${key}`;

export function optionProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return "Say when this applies";
  if (trimmed.length > MAX_OPTION_TEXT) {
    return `Keep it to ${commas(MAX_OPTION_TEXT)} characters`;
  }
  return null;
}

// the server's whole phrases, so a name never steers the field
const DECISION_FIELDS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^options\.(\S+) must be /, (m) => optionField(m[1]!)],
  [/^enabled must be /, () => "enabled"],
  [/^deciderId must be /, () => "decider"],
  [/^no such decider$/, () => "decider"],
];

export function decisionFieldOf(message: string): string | undefined {
  for (const [words, field] of DECISION_FIELDS) {
    const m = message.match(words);
    if (m) return field(m);
  }
  return undefined;
}
