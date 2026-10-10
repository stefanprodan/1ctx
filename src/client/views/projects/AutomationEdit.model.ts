// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the automation editor says about a save without a DOM: that it
// takes the task over, and that someone else's save came first.

import {
  type AutomationSummary,
  STALE_EDIT,
} from "../../../shared/contracts/automation.ts";
import { failure, sentence } from "../../lib/format.ts";

// a save that changes a field makes its editor the owner, so the save
// row says so on a task someone else owns
export function ownerNote(
  a: Pick<AutomationSummary, "ownerId"> | null,
  userId: string | null,
): string | null {
  if (a === null || userId === null || a.ownerId === userId) return null;
  return "Saving makes you the owner. Scheduled runs will act as you.";
}

// the refusal of a save someone else's change got to first
export const staleEdit = (
  problem: { error: string; status?: number } | null,
): boolean => problem?.status === 409 && problem.error === STALE_EDIT;

// a save's error that is that refusal
export function staleFailure(err: unknown): boolean {
  const { words, status } = failure(err);
  return staleEdit({ error: words, ...(status === null ? {} : { status }) });
}

// The words beside Reload. A stale save stays stale until Reload lands,
// whatever the form shows since: an edit clears the foot's notice, and
// Reload's own call clears it while it runs. Null while not stale, or
// while the notice still says it.
export function staleWords(
  stale: boolean,
  notice: { error: string; status?: number } | null,
): string | null {
  return stale && !staleEdit(notice) ? sentence(STALE_EDIT) : null;
}
