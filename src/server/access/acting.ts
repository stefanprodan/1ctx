// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The router checks the caller when the headers arrive; a write that
// first awaits a client-paced body reads the caller again inside its
// transaction, so a sign-out, disable, demotion or a changed admin key
// meanwhile stops it.

import type { Clock } from "../lib/clock.ts";
import { Forbidden, Unauthorized } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import type { UserRow } from "../users/index.ts";
import { type AdminKeys, loginHolds } from "./admin-keys.ts";
import type { LoginStore } from "./store.ts";

export type ActingDeps = {
  logins: Pick<LoginStore, "byId">;
  users: { byId(id: string): UserRow | null };
  adminKeys: Pick<AdminKeys, "digestOf">;
  clock: Clock;
};

// the caller's user as it stands now; call it inside the transaction
export function actingUser(
  deps: ActingDeps,
  principal: Principal,
  role: "admin" | null = null,
): UserRow {
  const login =
    principal.via.kind === "login" ? deps.logins.byId(principal.via.id) : null;
  if (
    login === null ||
    login.userId !== principal.userId ||
    login.expiresAt <= deps.clock()
  ) {
    throw new Unauthorized();
  }
  const user = deps.users.byId(principal.userId);
  if (user === null) throw new Unauthorized();
  if (user.disabled) throw new Forbidden();
  // the login itself ends at the next read or the minute's check
  if (!loginHolds(deps.adminKeys, login, user)) throw new Unauthorized();
  if (role === "admin" && user.role !== "admin") throw new Forbidden();
  return user;
}
