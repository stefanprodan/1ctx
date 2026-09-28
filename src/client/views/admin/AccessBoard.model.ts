// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Access board's words and groups: the users who used the app last,
// and the accounts and the team projects that need an admin, each
// account in one group only: disabled, else inactive when not seen in
// 30 days.

import type { AccessDay, AccessRecent } from "../../../shared/api/access.ts";
import type { AdminUser } from "../../../shared/api/users.ts";
import type { ProjectSummary } from "../../../shared/contracts/project.ts";
import { ago, dayMonth, plural } from "../../lib/format.ts";
import { idleDays } from "./Users.model.ts";

export const BOARD_DAYS = 30;

export type AccountGroups = {
  inactive: AdminUser[];
  disabled: AdminUser[];
};

export function accountGroups(
  users: readonly AdminUser[],
  now: number,
): AccountGroups {
  const groups: AccountGroups = { inactive: [], disabled: [] };
  for (const u of users) {
    if (u.disabled) groups.disabled.push(u);
    else {
      const idle = idleDays(u, now);
      if (idle === null || idle >= BOARD_DAYS) groups.inactive.push(u);
    }
  }
  return groups;
}

// the server's recent users with their rows, in its order; one the
// users list does not hold yet is left out
export function recentUsers(
  recent: readonly AccessRecent[],
  users: readonly AdminUser[],
): (AccessRecent & { user: AdminUser })[] {
  const byId = new Map(users.map((u) => [u.id, u]));
  const rows: (AccessRecent & { user: AdminUser })[] = [];
  for (const r of recent) {
    const user = byId.get(r.userId);
    if (user === undefined) continue;
    rows.push({ ...r, user });
  }
  return rows;
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

// a recent user's time: "online" while a tab of theirs is open, then
// how long ago
export const recentWhen = (r: AccessRecent, now: number): string =>
  r.online ? "online" : ago(r.at, now);
