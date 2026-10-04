// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The databases the builder makes, and the fixed clock they are built
// against, so two builds of one preset on one schema are one file.

export type Preset = {
  admins: number;
  members: number;
  teams: number;
  automations: number;
  deletedAutomations: number;
  agents: number;
  retiredAgents: number;
  // sends in flight at the snapshot
  runningRuns: number;
  runningChats: number;
  // one incident chat every this many hours
  incidentEvery: number;
  // how far back the history goes
  historyDays: number;
};

// the archive sweep and the chats sweep: a year and a month
const YEAR_AND_MONTH = 30 + 365;

export const PRESETS: Record<string, Preset> = {
  // the MVP at 1/20 of its users, teams and automations, a year of
  // history; full-size figures are extrapolated from it
  small: {
    admins: 3,
    members: 25,
    teams: 5,
    automations: 25,
    deletedAutomations: 1,
    agents: 8,
    retiredAgents: 2,
    runningRuns: 4,
    runningChats: 0,
    incidentEvery: 20,
    historyDays: YEAR_AND_MONTH,
  },
  // 100 users in 10 teams over three months, for comparing a branch
  // with main on a few hundred MB
  bench: {
    admins: 2,
    members: 100,
    teams: 10,
    automations: 20,
    deletedAutomations: 0,
    agents: 4,
    retiredAgents: 0,
    runningRuns: 0,
    runningChats: 0,
    incidentEvery: 48,
    historyDays: 90,
  },
  // seconds: the tests and the smoke run
  tiny: {
    admins: 1,
    members: 6,
    teams: 2,
    automations: 4,
    deletedAutomations: 1,
    agents: 3,
    retiredAgents: 1,
    runningRuns: 1,
    runningChats: 1,
    incidentEvery: 120,
    historyDays: 8,
  },
};

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
// a Tuesday at 10:00 UTC, working hours in Europe: the peak
export const NOW = Date.UTC(2026, 8, 29, 10, 0, 0);
export const ARCHIVE_IDLE_DAYS = 30;
export const ARCHIVED_DELETE_DAYS = 365;
export const RETENTION_DAYS = 30;
export const SCRATCH_IDLE_DAYS = 7;
// the hourly sweeps (chats, packing, retention) last ran then
export const LAST_SWEEP = NOW - 30 * MIN;
export const PACK_FROM = 1024;
export const RESULT_CUT = 50_000;
export const CUT_NOTE =
  "\n[result cut at 50000 characters; the whole result is kept under /mcp]";
// An argon2id hash of a value nobody kept, fixed so builds are the same
// file: nobody signs in to a built database until the local target
// sets a password of its own run
export const NO_PASSWORD =
  "$argon2id$v=19$m=65536,t=2,p=1$D8Q0jkML04qtHn8pVrqEK1E3nki5R8dazlCFxIFOpns$XaLvJsrcSKTwmISVbbnUzyw2+MAYpxSaawbRJOWDCVE";

export type Clock = { start: number; hours: number; historyDays: number };

export function clockOf(p: Preset): Clock {
  return {
    start: NOW - p.historyDays * DAY,
    hours: p.historyDays * 24,
    historyDays: p.historyDays,
  };
}
