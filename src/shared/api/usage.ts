// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// GET /api/usage/week: what the caller's visible projects spent over
// the past seven days: distinct sessions with a usage row, and the
// prompt and completion tokens summed; since is the window's start
export type WeekUsageResponse = {
  since: number;
  sessions: number;
  promptTokens: number;
  completionTokens: number;
};
