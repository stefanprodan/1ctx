// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AutomationDraft } from "../../shared/contracts/automation-draft.ts";

export type DraftsPort = {
  bySession(sessionId: string): AutomationDraft[];
  removePending(sessionId: string, sendIds: readonly string[]): void;
  expireSession(sessionId: string, now: number): number;
  expired(now: number, limit: number): string[];
  expire(id: string, now: number): boolean;
};
