// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// GET /api/usage/week?tz=: what the caller's visible projects spent
// over the last seven calendar days in the caller's zone, today
// included: distinct sends (the turns) and sessions with a usage row,
// and the prompt and completion tokens summed; since and until are the
// local midnights bounding it
export type WeekUsageResponse = {
  since: number;
  until: number;
  sends: number;
  sessions: number;
  promptTokens: number;
  completionTokens: number;
};

// A day's activity: distinct sends with a usage row in the day, and
// their prompt plus completion tokens
export type DayUsage = { sends: number; tokens: number };

// a year of columns, so the widest card fills with small cells
export const MAX_WEEKS = 53;

// GET /api/usage/days?tz=&weeks=: the caller's visible projects over
// the last weeks ISO weeks (1 to 53, the year when left out) in the
// caller's zone, Monday first, today last. since and
// until are the local midnights bounding the window; every project's
// usage is as long as days, zeros included; total counts a send once
// even when its rounds fall on two days
export type DaysUsageResponse = {
  since: number;
  until: number;
  days: string[];
  total: DayUsage;
  projects: { projectId: string; usage: DayUsage[] }[];
};
