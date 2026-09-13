// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The loop caps of the send, constants until the limits area exists
// (decision 4). The tool caps live in tools/limits.ts; these bound the
// loop the runner drives. The policy carries a copy, so a send runs
// under the caps decided when it started.

// the provider rounds a send may take, the answer round included
export const MAX_ROUNDS = 10;
// the tool calls one round may launch
export const MAX_CALLS_PER_ROUND = 10;
// the tool calls a send may launch across every round
export const MAX_CALLS_PER_SEND = 100;
// ten minutes of wall clock, the sum of each round's tool phase
export const MAX_TOOL_MS = 600_000;
// the sum of stored result bytes over a send, checked before a round's
// calls launch; each call is cut to 50,000 characters first, so ten
// parallel calls cannot pass the cap by more than one round
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;

export type LoopLimits = {
  rounds: number;
  callsPerRound: number;
  callsPerSend: number;
  toolMs: number;
  resultBytes: number;
};

export const LOOP_LIMITS: LoopLimits = {
  rounds: MAX_ROUNDS,
  callsPerRound: MAX_CALLS_PER_ROUND,
  callsPerSend: MAX_CALLS_PER_SEND,
  toolMs: MAX_TOOL_MS,
  resultBytes: MAX_RESULT_BYTES,
};
