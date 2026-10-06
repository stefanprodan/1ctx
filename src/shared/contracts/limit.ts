// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A limit as the admin pages show it: the value a send runs under, the
// code's default beside it, the floor and the ceiling the parser holds
// it to, and what the number counts. The row holds the runner's units,
// milliseconds and bytes; the page turns them into words.

// the limits an admin may override: the loop caps of a send, then the
// caps a single tool call runs under. The names are the keys the
// runner and the tools read, so a row maps to a cap without a table.
export const LIMIT_NAMES = [
  "rounds",
  "callsPerRound",
  "callsPerSend",
  "toolMs",
  "resultBytes",
  "toolWorkTokens",
  "contextReserve",
  "summaryMaxTokens",
  "callTimeoutMs",
  "resultCut",
  "maxBashCalls",
  "maxFetches",
  "maxSearches",
  "fetchBodyBytes",
  "searchBodyBytes",
  "fetchDeadlineMs",
  "searchDeadlineMs",
  "runDeadlineMs",
  "sendDeadlineMs",
  "memoryPhaseMs",
  "memoryPhaseRounds",
  "visualBytes",
  "visualSendBytes",
  "maxVisuals",
  "knowledgeFileBytes",
  "knowledgeFiles",
  "knowledgeProjectBytes",
  "knowledgeVersions",
  "knowledgeHistoryBytes",
  "knowledgeHistoryDays",
  "scratchBytes",
  "scratchFiles",
  "scratchIdleDays",
  "uploadBytes",
  "uploadFiles",
  "mcpKeptBytes",
  "mcpKeptFiles",
  "sendsPerUser",
  "sendsPerProject",
  "sendsRunning",
  "queuedPerUser",
  "queuedMinutes",
  "archiveIdleDays",
  "archivedDeleteDays",
  "repoBytes",
  "repoFiles",
  "repoFileBytes",
  "repoCacheBytes",
] as const;
export type LimitName = (typeof LIMIT_NAMES)[number];

export const LIMIT_UNITS = [
  "count",
  "ms",
  "bytes",
  "chars",
  "tokens",
  "days",
  "minutes",
] as const;
export type LimitUnit = (typeof LIMIT_UNITS)[number];

// knowledge caps are read at each write, sends caps at each admission
export const LIMIT_SCOPES = [
  "send",
  "call",
  "knowledge",
  "sends",
  "visuals",
  "chats",
  "repos",
] as const;
export type LimitScope = (typeof LIMIT_SCOPES)[number];

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
