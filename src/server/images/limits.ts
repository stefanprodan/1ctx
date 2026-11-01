// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The fixed budgets of images; the admin's are in limits/.

import { DAY_MS } from "../lib/clock.ts";

// a staged image waits for its send this long, as a staged upload does
export const IMAGE_LEASE_MS = DAY_MS;
// the staged images one user may hold at once, past a full message
export const MAX_STAGED_IMAGES = 32;
// the expired staged rows, and the rate's old rows, one sweep pass
// removes; the rest go next hour
export const SWEEP_BATCH = 1000;
// the sent images one claim or fork frees at most: a message of the
// largest images past the budget frees a few of its size, and a budget
// lowered by gigabytes frees a batch at each claim rather than
// thousands of rows in one send's transaction
export const FREE_BATCH = 256;
