// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// the code owns every default; a limits row is an admin's override alone

import type {
  LimitName,
  LimitScope,
  LimitUnit,
} from "../../shared/contracts/limit.ts";

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
  // a send's subagents: running together, started in all, and the
  // characters of an answer it reads back
  childrenAtOnce: number;
  childrenPerSend: number;
  childAnswerChars: number;
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
type QueueCaps = {
  queuedPerUser: number;
  queuedMinutes: number;
};

// the places scheduled runs may hold under a project's or the process's
// cap; the rest is kept for sends a user started, at least 1 at the
// floor of 4
export const scheduledShare = (cap: number): number =>
  Math.floor((cap * 3) / 4);

// the process cap's default: a pod carries sends by its CPU, 48 a core,
// half what a bench machine's core carried, since x86 cores run slower;
// inside a container the cores are the CPU limit, floored
export const sendsRunningDefault = (cores: number): number => {
  const whole = Number.isFinite(cores) ? Math.floor(cores) : 1;
  return Math.min(256, Math.max(64, 48 * whole));
};

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

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

const limit = (
  value: number,
  min: number,
  max: number,
  unit: LimitUnit,
  scope: LimitScope,
): LimitDefinition => ({ default: value, min, max, unit, scope });

// the table on one core: limitDefinitions() moves the process cap
export const LIMIT_DEFINITIONS: Record<LimitName, LimitDefinition> = {
  rounds: limit(100, 1, 500, "count", "send"),
  callsPerRound: limit(10, 1, 50, "count", "send"),
  callsPerSend: limit(100, 1, 1000, "count", "send"),
  toolMs: limit(600_000, 10_000, 3_600_000, "ms", "send"),
  resultBytes: limit(2 * MiB, 64 * KiB, 32 * MiB, "bytes", "send"),
  toolWorkTokens: limit(1_000_000, 10_000, 10_000_000, "tokens", "send"),
  contextReserve: limit(20_000, 1000, 200_000, "tokens", "send"),
  summaryMaxTokens: limit(4096, 1000, 32_000, "tokens", "send"),
  memoryPhaseMs: limit(120_000, 10_000, 600_000, "ms", "send"),
  memoryPhaseRounds: limit(4, 1, 20, "count", "send"),
  childrenAtOnce: limit(2, 1, 4, "count", "send"),
  childrenPerSend: limit(4, 1, 16, "count", "send"),
  // its ceiling and the files tail (runner/child-result.ts) fit the
  // transcript's display cut of a result, so the files always show
  childAnswerChars: limit(12_000, 1000, 16_000, "chars", "send"),
  callTimeoutMs: limit(20_000, 1000, 600_000, "ms", "call"),
  resultCut: limit(50_000, 1000, 500_000, "chars", "call"),
  maxBashCalls: limit(100, 1, 1000, "count", "call"),
  maxFetches: limit(6, 0, 100, "count", "call"),
  maxSearches: limit(3, 0, 100, "count", "call"),
  fetchBodyBytes: limit(2 * MiB, 64 * KiB, 32 * MiB, "bytes", "call"),
  searchBodyBytes: limit(MiB, 64 * KiB, 32 * MiB, "bytes", "call"),
  fetchDeadlineMs: limit(15_000, 1000, 600_000, "ms", "call"),
  searchDeadlineMs: limit(10_000, 1000, 600_000, "ms", "call"),
  runDeadlineMs: limit(600_000, 60_000, 3_600_000, "ms", "send"),
  sendDeadlineMs: limit(1_800_000, 60_000, 14_400_000, "ms", "send"),
  visualBytes: limit(256 * KiB, 16 * KiB, 512 * KiB, "bytes", "visuals"),
  visualSendBytes: limit(MiB, 64 * KiB, 4 * MiB, "bytes", "visuals"),
  maxVisuals: limit(2, 1, 10, "count", "visuals"),
  knowledgeFileBytes: limit(256 * KiB, 4 * KiB, 4 * MiB, "bytes", "knowledge"),
  knowledgeFiles: limit(500, 1, 10_000, "count", "knowledge"),
  knowledgeProjectBytes: limit(16 * MiB, MiB, 64 * MiB, "bytes", "knowledge"),
  knowledgeVersions: limit(20, 1, 200, "count", "knowledge"),
  knowledgeHistoryBytes: limit(64 * MiB, MiB, GiB, "bytes", "knowledge"),
  knowledgeHistoryDays: limit(90, 1, 3650, "days", "knowledge"),
  scratchBytes: limit(16 * MiB, MiB, 64 * MiB, "bytes", "knowledge"),
  scratchFiles: limit(1000, 10, 10_000, "count", "knowledge"),
  scratchIdleDays: limit(7, 1, 90, "days", "knowledge"),
  uploadBytes: limit(16 * MiB, MiB, 64 * MiB, "bytes", "knowledge"),
  uploadFiles: limit(1000, 10, 10_000, "count", "knowledge"),
  mcpKeptBytes: limit(32 * MiB, MiB, 256 * MiB, "bytes", "knowledge"),
  mcpKeptFiles: limit(2000, 10, 20_000, "count", "knowledge"),
  sendsPerUser: limit(4, 1, 16, "count", "sends"),
  sendsPerProject: limit(16, 4, 64, "count", "sends"),
  sendsRunning: limit(sendsRunningDefault(1), 4, 256, "count", "sends"),
  queuedPerUser: limit(8, 1, 32, "count", "sends"),
  queuedMinutes: limit(60, 10, 240, "minutes", "sends"),
  archiveIdleDays: limit(30, 1, 180, "days", "chats"),
  archivedDeleteDays: limit(365, 30, 1825, "days", "chats"),
  repoBytes: limit(256 * MiB, MiB, 2 * GiB, "bytes", "repos"),
  repoFiles: limit(50_000, 100, 500_000, "count", "repos"),
  repoFileBytes: limit(4 * MiB, 64 * KiB, 64 * MiB, "bytes", "repos"),
  repoCacheBytes: limit(10 * GiB, GiB, 1024 * GiB, "bytes", "repos"),
};

// the table on the given cores; only the process cap's default moves
export const limitDefinitions = (
  cores: number,
): Record<LimitName, LimitDefinition> => ({
  ...LIMIT_DEFINITIONS,
  sendsRunning: {
    ...LIMIT_DEFINITIONS.sendsRunning,
    default: sendsRunningDefault(cores),
  },
});

export const defaultLimits = (cores: number): Limits =>
  Object.fromEntries(
    Object.entries(limitDefinitions(cores)).map(([name, entry]) => [
      name,
      entry.default,
    ]),
  ) as Limits;

// the defaults on one core; a running server's are the limits area's,
// on its cores
export const DEFAULT_LIMITS = defaultLimits(1);
