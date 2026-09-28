// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Access board's words and groups: the accounts and the team
// projects that need an admin, each account in one group only, the
// first that holds it: disabled, then a password to change, then not
// seen in 30 days.

import type { AccessDay } from "../../../shared/api/access.ts";
import type { AdminUser } from "../../../shared/api/users.ts";
import type { ProjectSummary } from "../../../shared/contracts/project.ts";
import { dayMonth, plural } from "../../lib/format.ts";
import { idleDays } from "./Users.model.ts";

export const BOARD_DAYS = 30;

export type AccountGroups = {
  unseen: AdminUser[];
  password: AdminUser[];
  disabled: AdminUser[];
};

export function accountGroups(
  users: readonly AdminUser[],
  now: number,
): AccountGroups {
  const groups: AccountGroups = { unseen: [], password: [], disabled: [] };
  for (const u of users) {
    if (u.disabled) groups.disabled.push(u);
    else if (u.mustChangePassword) groups.password.push(u);
    else {
      const idle = idleDays(u, now);
      if (idle === null || idle >= BOARD_DAYS) groups.unseen.push(u);
    }
  }
  return groups;
}

export type ProjectGroups = {
  empty: ProjectSummary[];
  quiet: ProjectSummary[];
};

// a project with nobody in it is only in the first group
export function projectGroups(
  projects: readonly ProjectSummary[],
  activeIds: readonly string[],
): ProjectGroups {
  const active = new Set(activeIds);
  return {
    empty: projects.filter((p) => p.memberCount === 0),
    quiet: projects.filter((p) => p.memberCount > 0 && !active.has(p.id)),
  };
}

// the chart's line: the day under the pointer, else the whole span
export function signedInHint(
  signedIn: number,
  users: number,
  at: AccessDay | null,
): string {
  return at === null
    ? `${plural(signedIn, "user")} of ${users} in ${BOARD_DAYS} days`
    : `${dayMonth(at.start)} · ${plural(at.signedIn, "user")}`;
}
