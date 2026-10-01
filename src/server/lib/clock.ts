// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Milliseconds since the epoch, as a port so a test can move time.

export type Clock = (() => number) & {
  sleep?: (ms: number) => Promise<void>;
};

export const wallClock: Clock = () => Date.now();

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
