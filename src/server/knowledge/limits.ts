// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The fixed budgets of a disposable knowledge mount. The body budget
// leaves room for JSON escaping at the cap; a cancelled command has a
// moment to stop on its own before its worker is ended.

import { MAX_REQUEST_BYTES } from "../lib/body.ts";
import { LIMIT_DEFINITIONS } from "../limits/index.ts";

export { KNOWLEDGE_COMMANDS, MAX_OPENS_PER_COMMAND } from "./commands.ts";

export const RECENT_FILES = 5;
export const KNOWLEDGE_COMMANDS_IN_FLIGHT = 4;
export const MAX_KNOWLEDGE_BODY = 3 * LIMIT_DEFINITIONS.knowledgeFileBytes.max;
export const MAX_ARCHIVE_UPLOAD = MAX_REQUEST_BYTES;
export const MAX_ARCHIVE_EXPANDED = LIMIT_DEFINITIONS.knowledgeProjectBytes.max;
export const MAX_ARCHIVE_MEMBERS = 2_000;
export const ARCHIVE_DEADLINE_MS = 60_000;
export const UPLOAD_LEASE_MS = 24 * 60 * 60 * 1_000;
export const MAX_STAGED_ITEMS = 20;
export const CANCEL_GRACE_MS = 500;
