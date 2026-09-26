// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the decision routes, all for admins.

import type { DecisionSummary } from "../contracts/decision.ts";

// GET /api/decisions, in the order of DECISIONS
export type DecisionsResponse = { decisions: DecisionSummary[] };

// PUT /api/decisions/:id: the whole settings. deciderId is a decider's
// id or null for the default; options names every option key of the
// decision once, each description trimmed, 1 to MAX_OPTION_TEXT
// characters, the text in code again dropping the admin's own. Answers
// the decision as it is asked from then on
export type SaveDecisionRequest = {
  enabled: boolean;
  deciderId: string | null;
  options: Record<string, string>;
};
export type DecisionResponse = { decision: DecisionSummary };
