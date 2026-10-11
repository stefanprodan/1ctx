// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { BusEvent } from "../lib/bus.ts";

// The caller's transaction keeps access and claims together.
export type TaskClaimsPort = {
  endForKeys(keyIds: readonly string[]): BusEvent[];
  endForUser(userId: string, projectIds: readonly string[]): BusEvent[];
};
