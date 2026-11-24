// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A message written earlier starts as its author is now: a role
// changed, a login disabled or a project left since counts.

import { BadRequest } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import type { UserRow } from "../users/index.ts";

export function liveAuthor(user: UserRow | null): UserRow {
  if (user === null) throw new BadRequest("the user is gone");
  if (user.disabled) throw new BadRequest("the user is disabled");
  return user;
}

export const principalOf = (user: UserRow): Principal => ({
  userId: user.id,
  username: user.username,
  fullName: user.fullName,
  role: user.role,
  // no login stands behind a message that starts later
  via: { kind: "login", id: "" },
});

export function requiredUser(
  users: { byId(id: string): UserRow | null },
  id: string,
): UserRow {
  const user = users.byId(id);
  if (user === null) throw new BadRequest("the user is gone");
  return user;
}

export function requiredAgent<T>(
  agents: { byId(id: string): T | null },
  id: string,
): T {
  const agent = agents.byId(id);
  if (agent === null) throw new BadRequest("no such agent");
  return agent;
}
