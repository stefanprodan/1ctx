// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Passkeys card's lines, kept apart from the page.

import type { Passkey } from "../../../shared/api/profile.ts";
import { dayMonth, dayMonthYear } from "../../lib/format.ts";

// the card's line beside its title, and its note with none
export const PASSKEYS_TEXT =
  "Use Face ID, Touch ID or your password manager instead of a code.";
export const NO_PASSKEYS = "No passkeys yet.";

// every origin's is listed, so one added at another address never hides;
// it signs in only there, port included, so its row names it
export function elsewhere(p: Pick<Passkey, "origin">, origin: string) {
  if (p.origin === origin) return null;
  try {
    return new URL(p.origin).host;
  } catch {
    return p.origin;
  }
}

// "12 Nov", with the year once it is not this one
function on(ms: number, now: number): string {
  return new Date(ms).getFullYear() === new Date(now).getFullYear()
    ? dayMonth(ms)
    : dayMonthYear(ms);
}

// on the reader's own calendar; none used until a sign-in, since the add
// itself asked for the face or finger
export function passkeyLines(
  p: Pick<Passkey, "createdAt" | "lastUsedAt">,
  now: number,
): { added: string; used: string } {
  return {
    added: `Added ${on(p.createdAt, now)}`,
    used:
      p.lastUsedAt === null
        ? "Never used"
        : `Last used ${on(p.lastUsedAt, now)}`,
  };
}
