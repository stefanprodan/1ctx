// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words of an access key's row, the same on Connect agents and on an
// admin's user page.

import type {
  AccessKey,
  AccessKeyScope,
} from "../../../shared/contracts/access-key.ts";
import { ago, dayMonthYear, plural } from "../../lib/format.ts";

export const REVOKE_ASK = "Agents using it lose access.";

export const scopeWords = (scope: AccessKeyScope): string =>
  scope === "read" ? "Read" : "Read and write";

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

export const createdWords = (key: Pick<AccessKey, "createdAt">): string =>
  `Created ${dayMonthYear(key.createdAt)}`;

export const usedWords = (
  key: Pick<AccessKey, "lastUsedAt">,
  now: number,
): string =>
  key.lastUsedAt === null ? "Never used" : `Used ${ago(key.lastUsedAt, now)}`;

export const expired = (key: Pick<AccessKey, "expiresAt">, now: number) =>
  key.expiresAt <= now;

export const expiryWords = (
  key: Pick<AccessKey, "expiresAt">,
  now: number,
): string =>
  `${expired(key, now) ? "Expired" : "Expires"} ${dayMonthYear(key.expiresAt)}`;
