// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The repos area's fixed bounds; the sizes an admin sets are limits rows.

// a fetch's whole deadline, and how long it may go without a byte
export const REPO_FETCH_MS = 5 * 60 * 1000;
export const REPO_STALL_MS = 30 * 1000;
// how long a turn waits for a cold tree before it goes on without it
export const REPO_WAIT_MS = 15 * 1000;
// a lookup's answer is shared this long, by URL, ref and key
export const REPO_LOOKUP_MS = 60 * 1000;
// an API lookup's own deadline
export const REPO_LOOKUP_DEADLINE_MS = 20 * 1000;
// a tree over the caps is not fetched again for this long
export const REPO_REFUSED_MS = 60 * 60 * 1000;
// the longest a fetch waits for its slots with the host's answer open
export const REPO_SLOT_WAIT_MS = 2 * 60 * 1000;
// fetches at once, each in a process slot, so commands keep the rest
export const REPO_FETCHES_IN_FLIGHT = 2;
// the most an API lookup's body is read
export const REPO_LOOKUP_BYTES = 64 * 1024;
