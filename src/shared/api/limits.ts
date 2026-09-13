// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the limits routes, all for admins. A
// change applies to the next send.

import type { LimitRow } from "../contracts/limit.ts";
import type { LimitName } from "../words.ts";

// GET /api/limits, and what PUT /api/limits answers
export type LimitsResponse = { limits: LimitRow[] };

// PUT /api/limits: the full set, every name present, every value an
// integer between the row's floor and ceiling; a value equal to the
// default drops the override. DELETE /api/limits answers 204 with
// every override gone.
export type PutLimitsRequest = { values: Record<LimitName, number> };
