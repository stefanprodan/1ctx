// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tool caps, constants until the limits area exists (decision 4).
// The loop caps (rounds, calls per round and per send, tool time,
// result bytes) live in runner/limits.ts; these are the caps a single
// tool runs under. The runner passes a copy in the tool context, so
// tools/ never imports runner/.

import type { ToolCaps } from "./types.ts";

export const TOOL_CAPS: ToolCaps = {
  callTimeoutMs: 20_000,
  resultCut: 50_000,
  maxFetches: 6,
  maxSearches: 3,
  fetchBodyBytes: 2 * 1024 * 1024,
  searchBodyBytes: 1024 * 1024,
  fetchDeadlineMs: 15_000,
  searchDeadlineMs: 10_000,
};
