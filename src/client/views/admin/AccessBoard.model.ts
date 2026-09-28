// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AccessDay, AccessRecent } from "../../../shared/api/access.ts";
import type { AdminUser } from "../../../shared/api/users.ts";
import type { ProjectSummary } from "../../../shared/contracts/project.ts";
import { ago, dayMonth, plural } from "../../lib/format.ts";
import { idleDays } from "./Users.model.ts";

export const BOARD_DAYS = 30;

type AccountGroups = {
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

// one the users list does not hold yet is left out
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

type ProjectGroups = {
  empty: ProjectSummary[];
  quiet: ProjectSummary[];
};

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

export function signedInHint(
  signedIn: number,
  users: number,
  at: AccessDay | null,
): string {
  return at === null
    ? `${plural(signedIn, "user")} of ${users} in ${BOARD_DAYS} days`
    : `${dayMonth(at.start)} · ${plural(at.signedIn, "user")}`;
}

export const recentWhen = (r: AccessRecent, now: number): string =>
  r.online ? "online" : ago(r.at, now);
