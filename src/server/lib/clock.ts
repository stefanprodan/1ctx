// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Milliseconds since the epoch, as a port so a test can move time.

export type Clock = () => number;

export const wallClock: Clock = () => Date.now();
