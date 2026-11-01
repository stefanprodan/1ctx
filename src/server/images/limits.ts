// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The fixed budgets of images; the admin's are in limits/.

import { DAY_MS } from "../lib/clock.ts";

// a staged image waits for its send this long, as a staged upload does
export const IMAGE_LEASE_MS = DAY_MS;
// the staged images one user may hold at once, past a full message
export const MAX_STAGED_IMAGES = 32;
// the expired staged rows one sweep pass removes, the rest going next
// hour; and the rate's old rows one statement removes, a pass looping
// until none is left
export const SWEEP_BATCH = 1000;
// the sent images one claim or fork frees at most: a message of the
// largest images past the budget frees a few of its size, and a budget
// lowered by gigabytes frees a batch at each claim rather than
// thousands of rows in one send's transaction
export const FREE_BATCH = 256;
// the ingests that decode at once, process-wide and apart from the
// process slots: a decode holds up to 4 bytes a pixel, so two at the
// 100 MP ceiling hold 800 MB of pixels where the slots would let 16 run
export const MAX_DECODES = 2;
