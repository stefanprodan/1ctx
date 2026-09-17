// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one table of the limits: the loop caps of a send and the caps a
// single tool call runs under, each with its default, the floor and
// the ceiling the parser holds an admin to, its unit and its scope.
// The code owns the defaults; a row in the limits table is an override
// alone, so a default that changes in code changes for every server
// that never overrode it. runner/limits.ts and tools/limits.ts re-export
// from here, so tools/ never imports runner/.

import type { LimitName, LimitScope, LimitUnit } from "../../shared/words.ts";

export type LoopLimits = {
  rounds: number;
  callsPerRound: number;
  callsPerSend: number;
  toolMs: number;
  resultBytes: number;
  contextReserve: number;
  summaryMaxTokens: number;
  memoryPhaseMs: number;
  memoryPhaseRounds: number;
};

export type ToolCaps = {
  callTimeoutMs: number;
  resultCut: number;
  maxFetches: number;
  maxSearches: number;
  fetchBodyBytes: number;
  searchBodyBytes: number;
  fetchDeadlineMs: number;
  searchDeadlineMs: number;
  visualBytes: number;
  visualSendBytes: number;
};

export type Limits = LoopLimits & ToolCaps & { runDeadlineMs: number };

export type LimitDefinition = {
  default: number;
  min: number;
  max: number;
  unit: LimitUnit;
  scope: LimitScope;
};

export const LIMIT_DEFINITIONS: Record<LimitName, LimitDefinition> = {
  rounds: { default: 10, min: 1, max: 50, unit: "count", scope: "send" },
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
  visualBytes: {
    default: 256 * 1024,
    min: 16 * 1024,
    max: 512 * 1024,
    unit: "bytes",
    scope: "call",
  },
  visualSendBytes: {
    default: 1024 * 1024,
    min: 64 * 1024,
    max: 4 * 1024 * 1024,
    unit: "bytes",
    scope: "send",
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
  contextReserve: DEFAULT_LIMITS.contextReserve,
  summaryMaxTokens: DEFAULT_LIMITS.summaryMaxTokens,
  memoryPhaseMs: DEFAULT_LIMITS.memoryPhaseMs,
  memoryPhaseRounds: DEFAULT_LIMITS.memoryPhaseRounds,
};

export const TOOL_CAPS: ToolCaps = {
  callTimeoutMs: DEFAULT_LIMITS.callTimeoutMs,
  resultCut: DEFAULT_LIMITS.resultCut,
  maxFetches: DEFAULT_LIMITS.maxFetches,
  maxSearches: DEFAULT_LIMITS.maxSearches,
  fetchBodyBytes: DEFAULT_LIMITS.fetchBodyBytes,
  searchBodyBytes: DEFAULT_LIMITS.searchBodyBytes,
  fetchDeadlineMs: DEFAULT_LIMITS.fetchDeadlineMs,
  searchDeadlineMs: DEFAULT_LIMITS.searchDeadlineMs,
  visualBytes: DEFAULT_LIMITS.visualBytes,
  visualSendBytes: DEFAULT_LIMITS.visualSendBytes,
};
