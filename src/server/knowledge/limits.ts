// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The fixed budgets of the docs and uploads. The body budget leaves room
// for JSON escaping at the cap; the process bound is shared by commands,
// archives and staging.

import { availableParallelism } from "node:os";
import { MAX_REQUEST_BYTES } from "../lib/body.ts";
import { DAY_MS } from "../lib/clock.ts";
import { LIMIT_DEFINITIONS } from "../limits/index.ts";

// each slot holds a mount in memory and a worker on a core; inside a
// container the cores are the CPU limit, floored. At least four, as
// before, since a command waiting on the network holds a slot idle
export const processSlots = (cores: number) => Math.min(16, Math.max(4, cores));
export const PROCESS_SLOTS = processSlots(availableParallelism());
export const MAX_KNOWLEDGE_BODY = 3 * LIMIT_DEFINITIONS.knowledgeFileBytes.max;
export const MAX_ARCHIVE_UPLOAD = MAX_REQUEST_BYTES;
export const MAX_ARCHIVE_EXPANDED = LIMIT_DEFINITIONS.knowledgeProjectBytes.max;
export const MAX_ARCHIVE_MEMBERS = 2_000;
export const ARCHIVE_DEADLINE_MS = 60_000;
export const UPLOAD_LEASE_MS = DAY_MS;
export const MAX_STAGED_ITEMS = 20;
