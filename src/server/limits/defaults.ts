// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one table of the limits: the loop caps of a send, the caps a
// single tool call runs under and the caps on the chats and runs going
// at once, each with its default, the floor and the ceiling the parser
// holds an admin to, its unit and its scope.
// The code owns the defaults; a row in the limits table is an override
// alone, so a default that changes in code changes for every server
// that never overrode it.

import type { LimitName, LimitScope, LimitUnit } from "../../shared/words.ts";

export type LoopLimits = {
  rounds: number;
  callsPerRound: number;
  callsPerSend: number;
  toolMs: number;
  resultBytes: number;
  toolWorkTokens: number;
  contextReserve: number;
  summaryMaxTokens: number;
  memoryPhaseMs: number;
  memoryPhaseRounds: number;
};

export type ToolCaps = {
  callTimeoutMs: number;
  resultCut: number;
  maxBashCalls: number;
  maxFetches: number;
  maxSearches: number;
  fetchBodyBytes: number;
  searchBodyBytes: number;
  fetchDeadlineMs: number;
  searchDeadlineMs: number;
  visualBytes: number;
  visualSendBytes: number;
  maxVisuals: number;
};

// the storage caps of a project's knowledge base and a session's scratch,
// read at each write
export type KnowledgeCaps = {
  knowledgeFileBytes: number;
  knowledgeFiles: number;
  knowledgeProjectBytes: number;
  knowledgeVersions: number;
  knowledgeHistoryBytes: number;
  knowledgeHistoryDays: number;
  scratchBytes: number;
  scratchFiles: number;
  scratchIdleDays: number;
  uploadBytes: number;
  uploadFiles: number;
  mcpKeptBytes: number;
  mcpKeptFiles: number;
};

// the chats and runs going at once, read at each admission: per user
// who started one, per project, and in the process
export type SendCaps = {
  sendsPerUser: number;
  sendsPerProject: number;
  sendsRunning: number;
};

// the messages sent to a busy chat one user may have waiting, not sent
// ones included, and the minutes one may wait from when it was sent
export type QueueCaps = {
  queuedPerUser: number;
  queuedMinutes: number;
};

// the places scheduled runs may hold under a project's or the process's
// cap; the rest is kept for sends a user started, at least 1 at the
// floor of 4
export const scheduledShare = (cap: number): number =>
  Math.floor((cap * 3) / 4);

// the days the hourly sweep archives an idle chat after, and deletes
// an archived chat after; neither has an off value
export type ChatCaps = {
  archiveIdleDays: number;
  archivedDeleteDays: number;
};

// a repository's tree as the ignore rules keep it, read at each fetch,
// and the cache of every tree, read at each fetch and sweep
export type RepoCaps = {
  repoBytes: number;
  repoFiles: number;
  repoFileBytes: number;
  repoCacheBytes: number;
};

export type Limits = LoopLimits &
  ToolCaps &
  KnowledgeCaps &
  SendCaps &
  QueueCaps &
  ChatCaps &
  RepoCaps & { runDeadlineMs: number; sendDeadlineMs: number };

export type LimitDefinition = {
  default: number;
  min: number;
  max: number;
  unit: LimitUnit;
  scope: LimitScope;
};

export const LIMIT_DEFINITIONS: Record<LimitName, LimitDefinition> = {
  rounds: { default: 100, min: 1, max: 500, unit: "count", scope: "send" },
  callsPerRound: {
    default: 10,
    min: 1,
    max: 50,
    unit: "count",
    scope: "send",
  },
  callsPerSend: {
    default: 100,
    min: 1,
    max: 1000,
    unit: "count",
    scope: "send",
  },
  toolMs: {
    default: 600_000,
    min: 10_000,
    max: 3_600_000,
    unit: "ms",
    scope: "send",
  },
  resultBytes: {
    default: 2 * 1024 * 1024,
    min: 64 * 1024,
    max: 32 * 1024 * 1024,
    unit: "bytes",
    scope: "send",
  },
  toolWorkTokens: {
    default: 1_000_000,
    min: 10_000,
    max: 10_000_000,
    unit: "tokens",
    scope: "send",
  },
  contextReserve: {
    default: 20_000,
    min: 1000,
    max: 200_000,
    unit: "tokens",
    scope: "send",
  },
  summaryMaxTokens: {
    default: 4096,
    min: 256,
    max: 32_768,
    unit: "tokens",
    scope: "send",
  },
  memoryPhaseMs: {
    default: 120_000,
    min: 10_000,
    max: 600_000,
    unit: "ms",
    scope: "send",
  },
  memoryPhaseRounds: {
    default: 4,
    min: 1,
    max: 20,
    unit: "count",
    scope: "send",
  },
  callTimeoutMs: {
    default: 20_000,
    min: 1000,
    max: 600_000,
    unit: "ms",
    scope: "call",
  },
  resultCut: {
    default: 50_000,
    min: 1000,
    max: 500_000,
    unit: "chars",
    scope: "call",
  },
  maxBashCalls: {
    default: 100,
    min: 1,
    max: 1000,
    unit: "count",
    scope: "call",
  },
  maxFetches: {
    default: 6,
    min: 0,
    max: 100,
    unit: "count",
    scope: "call",
  },
  maxSearches: {
    default: 3,
    min: 0,
    max: 100,
    unit: "count",
    scope: "call",
  },
  fetchBodyBytes: {
    default: 2 * 1024 * 1024,
    min: 64 * 1024,
    max: 32 * 1024 * 1024,
    unit: "bytes",
    scope: "call",
  },
  searchBodyBytes: {
    default: 1024 * 1024,
    min: 64 * 1024,
    max: 32 * 1024 * 1024,
    unit: "bytes",
    scope: "call",
  },
  fetchDeadlineMs: {
    default: 15_000,
    min: 1000,
    max: 600_000,
    unit: "ms",
    scope: "call",
  },
  searchDeadlineMs: {
    default: 10_000,
    min: 1000,
    max: 600_000,
    unit: "ms",
    scope: "call",
  },
  runDeadlineMs: {
    default: 600_000,
    min: 60_000,
    max: 3_600_000,
    unit: "ms",
    scope: "send",
  },
  sendDeadlineMs: {
    default: 1_800_000,
    min: 60_000,
    max: 14_400_000,
    unit: "ms",
    scope: "send",
  },
  visualBytes: {
    default: 256 * 1024,
    min: 16 * 1024,
    max: 512 * 1024,
    unit: "bytes",
    scope: "visuals",
  },
  visualSendBytes: {
    default: 1024 * 1024,
    min: 64 * 1024,
    max: 4 * 1024 * 1024,
    unit: "bytes",
    scope: "visuals",
  },
  maxVisuals: {
    default: 2,
    min: 1,
    max: 10,
    unit: "count",
    scope: "visuals",
  },
  knowledgeFileBytes: {
    default: 256 * 1024,
    min: 4 * 1024,
    max: 4 * 1024 * 1024,
    unit: "bytes",
    scope: "knowledge",
  },
  knowledgeFiles: {
    default: 500,
    min: 1,
    max: 10_000,
    unit: "count",
    scope: "knowledge",
  },
  knowledgeProjectBytes: {
    default: 16 * 1024 * 1024,
    min: 1024 * 1024,
    max: 64 * 1024 * 1024,
    unit: "bytes",
    scope: "knowledge",
  },
  knowledgeVersions: {
    default: 20,
    min: 1,
    max: 200,
    unit: "count",
    scope: "knowledge",
  },
  knowledgeHistoryBytes: {
    default: 64 * 1024 * 1024,
    min: 1024 * 1024,
    max: 1024 * 1024 * 1024,
    unit: "bytes",
    scope: "knowledge",
  },
  knowledgeHistoryDays: {
    default: 90,
    min: 1,
    max: 3650,
    unit: "days",
    scope: "knowledge",
  },
  scratchBytes: {
    default: 16 * 1024 * 1024,
    min: 1024 * 1024,
    max: 64 * 1024 * 1024,
    unit: "bytes",
    scope: "knowledge",
  },
  scratchFiles: {
    default: 1000,
    min: 10,
    max: 10_000,
    unit: "count",
    scope: "knowledge",
  },
  scratchIdleDays: {
    default: 7,
    min: 1,
    max: 90,
    unit: "days",
    scope: "knowledge",
  },
  uploadBytes: {
    default: 16 * 1024 * 1024,
    min: 1024 * 1024,
    max: 64 * 1024 * 1024,
    unit: "bytes",
    scope: "knowledge",
  },
  uploadFiles: {
    default: 1000,
    min: 10,
    max: 10_000,
    unit: "count",
    scope: "knowledge",
  },
  mcpKeptBytes: {
    default: 32 * 1024 * 1024,
    min: 1024 * 1024,
    max: 256 * 1024 * 1024,
    unit: "bytes",
    scope: "knowledge",
  },
  mcpKeptFiles: {
    default: 2000,
    min: 10,
    max: 20_000,
    unit: "count",
    scope: "knowledge",
  },
  sendsPerUser: { default: 4, min: 1, max: 16, unit: "count", scope: "sends" },
  sendsPerProject: {
    default: 16,
    min: 4,
    max: 64,
    unit: "count",
    scope: "sends",
  },
  sendsRunning: {
    default: 64,
    min: 4,
    max: 256,
    unit: "count",
    scope: "sends",
  },
  queuedPerUser: {
    default: 8,
    min: 1,
    max: 32,
    unit: "count",
    scope: "sends",
  },
  queuedMinutes: {
    default: 60,
    min: 10,
    max: 240,
    unit: "minutes",
    scope: "sends",
  },
  archiveIdleDays: {
    default: 30,
    min: 1,
    max: 180,
    unit: "days",
    scope: "chats",
  },
  archivedDeleteDays: {
    default: 365,
    min: 30,
    max: 1825,
    unit: "days",
    scope: "chats",
  },
  repoBytes: {
    default: 256 * 1024 * 1024,
    min: 1024 * 1024,
    max: 2 * 1024 * 1024 * 1024,
    unit: "bytes",
    scope: "repos",
  },
  repoFiles: {
    default: 50_000,
    min: 100,
    max: 500_000,
    unit: "count",
    scope: "repos",
  },
  repoFileBytes: {
    default: 4 * 1024 * 1024,
    min: 64 * 1024,
    max: 64 * 1024 * 1024,
    unit: "bytes",
    scope: "repos",
  },
  repoCacheBytes: {
    default: 10 * 1024 * 1024 * 1024,
    min: 1024 * 1024 * 1024,
    max: 1024 * 1024 * 1024 * 1024,
    unit: "bytes",
    scope: "repos",
  },
};

export const DEFAULT_LIMITS = Object.fromEntries(
  Object.entries(LIMIT_DEFINITIONS).map(([name, entry]) => [
    name,
    entry.default,
  ]),
) as Limits;

export const LOOP_LIMITS: LoopLimits = {
  rounds: DEFAULT_LIMITS.rounds,
  callsPerRound: DEFAULT_LIMITS.callsPerRound,
  callsPerSend: DEFAULT_LIMITS.callsPerSend,
  toolMs: DEFAULT_LIMITS.toolMs,
  resultBytes: DEFAULT_LIMITS.resultBytes,
  toolWorkTokens: DEFAULT_LIMITS.toolWorkTokens,
  contextReserve: DEFAULT_LIMITS.contextReserve,
  summaryMaxTokens: DEFAULT_LIMITS.summaryMaxTokens,
  memoryPhaseMs: DEFAULT_LIMITS.memoryPhaseMs,
  memoryPhaseRounds: DEFAULT_LIMITS.memoryPhaseRounds,
};

export const TOOL_CAPS: ToolCaps = {
  callTimeoutMs: DEFAULT_LIMITS.callTimeoutMs,
  resultCut: DEFAULT_LIMITS.resultCut,
  maxBashCalls: DEFAULT_LIMITS.maxBashCalls,
  maxFetches: DEFAULT_LIMITS.maxFetches,
  maxSearches: DEFAULT_LIMITS.maxSearches,
  fetchBodyBytes: DEFAULT_LIMITS.fetchBodyBytes,
  searchBodyBytes: DEFAULT_LIMITS.searchBodyBytes,
  fetchDeadlineMs: DEFAULT_LIMITS.fetchDeadlineMs,
  searchDeadlineMs: DEFAULT_LIMITS.searchDeadlineMs,
  visualBytes: DEFAULT_LIMITS.visualBytes,
  visualSendBytes: DEFAULT_LIMITS.visualSendBytes,
  maxVisuals: DEFAULT_LIMITS.maxVisuals,
};
