// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A message written earlier starts as its author is now: a role
// changed, a login disabled or a project left since counts.

import { BadRequest, Forbidden } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import type { UserRow } from "../users/index.ts";

export function liveAuthor(user: UserRow | null): UserRow {
  if (user === null) throw new BadRequest("the user is gone");
  if (user.disabled) throw new BadRequest("the user is disabled");
  // as the router refuses every request of theirs
  if (user.mustChangePassword) {
    throw new Forbidden("change your password first");
  }
  return user;
}

export const principalOf = (user: UserRow): Principal => ({
  userId: user.id,
  username: user.username,
  fullName: user.fullName,
  role: user.role,
  mustChangePassword: user.mustChangePassword,
  // no login stands behind a message that starts later
  loginId: "",
});
