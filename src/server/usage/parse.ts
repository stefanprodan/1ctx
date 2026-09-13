// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The week route takes no parameter; one that arrives is a 400, as
// every parser answers the unexpected.

import { BadRequest } from "../lib/errors.ts";

export function parseWeekUsageQuery(url: URL): void {
  for (const name of url.searchParams.keys()) {
    throw new BadRequest(`unknown parameter ${name}`);
  }
}
