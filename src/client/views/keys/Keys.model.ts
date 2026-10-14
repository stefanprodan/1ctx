// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words of an access key's row, the same on Connect agents and on an
// admin's user page.

import type { AccessKey } from "../../../shared/contracts/access-key.ts";
import { ago, dayMonth, dayMonthYear, plural } from "../../lib/format.ts";

const DAY = 86_400_000;
// a key this close to its end is worth a look
export const SOON = 7 * DAY;

// where focus goes as the Revoke ask opens or closes: its Revoke, or
// back to the row's More button
export function askFocus(was: boolean, asking: boolean): "ask" | "more" | null {
  if (was === asking) return null;
  return asking ? "ask" : "more";
}

// the ask names when the key was made, which the row leaves out
export const revokeAsk = (key: Pick<AccessKey, "createdAt">): string =>
  `Created ${dayMonthYear(key.createdAt)}. Agents using it lose access.`;

// the picks by name; one the user no longer sees is counted, not named
export function reachWords(
  key: Pick<AccessKey, "projectIds">,
  projects: readonly { id: string; name: string }[],
): string {
  if (key.projectIds === null) return "Every project";
  const names = key.projectIds
    .map((id) => projects.find((p) => p.id === id)?.name)
    .filter((name): name is string => name !== undefined);
  const hidden = key.projectIds.length - names.length;
  if (names.length === 0) return plural(hidden, "project");
  return hidden === 0
    ? names.join(", ")
    : `${names.join(", ")} and ${hidden} more`;
}

export const usedWords = (
  key: Pick<AccessKey, "lastUsedAt">,
  now: number,
): string =>
  key.lastUsedAt === null ? "never used" : `used ${ago(key.lastUsedAt, now)}`;

export const expired = (key: Pick<AccessKey, "expiresAt">, now: number) =>
  key.expiresAt <= now;

export const expiresSoon = (key: Pick<AccessKey, "expiresAt">, now: number) =>
  !expired(key, now) && key.expiresAt - now <= SOON;

// the year only when it is not this one
export function expiryWords(
  key: Pick<AccessKey, "expiresAt">,
  now: number,
): string {
  const year =
    new Date(key.expiresAt).getFullYear() !== new Date(now).getFullYear();
  const day = year ? dayMonthYear(key.expiresAt) : dayMonth(key.expiresAt);
  return `${expired(key, now) ? "expired" : "expires"} ${day}`;
}
