// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A decision as the wire exposes it: a question a feature asks a
// decider, named after its subject and what it asks. Its question and
// its option keys are fixed in code, since the model reads the keys;
// an admin turns it on or off, picks its decider and rewrites what
// each option means.

export const DECISIONS = ["run-attention"] as const;
export type DecisionId = (typeof DECISIONS)[number];
export function isDecisionId(value: unknown): value is DecisionId {
  return (
    typeof value === "string" &&
    (DECISIONS as readonly string[]).includes(value)
  );
}

// what an answered decision is counted for: a decider's Check, or a
// decision
export const DECISION_PURPOSES = ["check", ...DECISIONS] as const;
export type DecisionPurpose = (typeof DECISION_PURPOSES)[number];

// each decision's options in the order they are drawn, with what the
// decider is told each means unless an admin wrote their own
export const DECISION_OPTIONS: Record<
  DecisionId,
  readonly { key: string; description: string }[]
> = {
  "run-attention": [
    {
      key: "all-good",
      description:
        "The task finished using the live sources it was meant to use and everything is fine, nothing to do",
    },
    {
      key: "needs-attention",
      description:
        "The task could not finish, could not reach a tool or source it needed and fell back on older or indirect data, or its answer reports a problem, an error or a failure anywhere, even one it calls unrelated or mentions only as a side note",
    },
  ],
};

export const MAX_OPTION_TEXT = 1000;

// the chance of needs-attention at which a finished run is marked
export const ATTENTION_AT = 0.5;

export type DecisionOption = {
  key: string;
  // what the decider is told now, and the text in code
  description: string;
  default: string;
};

export type DecisionSummary = {
  id: DecisionId;
  // off, the feature never asks
  enabled: boolean;
  // the decider asked, null for the default one
  deciderId: string | null;
  options: DecisionOption[];
};
