// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A limit as the tools page shows it: the value a send runs under, the
// code's default beside it, the floor and the ceiling the parser holds
// it to, and what the number counts. The row holds the runner's units,
// milliseconds and bytes; the page turns them into words.

import type { LimitName, LimitScope, LimitUnit } from "../words.ts";

export type LimitRow = {
  name: LimitName;
  value: number;
  default: number;
  min: number;
  max: number;
  unit: LimitUnit;
  scope: LimitScope;
  // when an admin last changed it; null while it is the default
  changedAt: number | null;
};
