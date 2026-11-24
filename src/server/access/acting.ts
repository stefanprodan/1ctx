// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The router checks the caller when the headers arrive; a write that
// first awaits a client-paced body reads the caller again inside its
// transaction, so a sign-out, disable, demotion or a changed admin key
// meanwhile stops it.

import { type Db, type Transaction, transact } from "../db/index.ts";
import { loginRevoked } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import { Forbidden, Unauthorized } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import type { UserRow } from "../users/index.ts";
import { type AdminKeys, loginHolds } from "./admin-keys.ts";
import type { Login, LoginStore } from "./store.ts";

export type ActingDeps = {
  db: Db;
  logins: Pick<LoginStore, "byId" | "delete">;
  users: { byId(id: string): UserRow | null };
  adminKeys: Pick<AdminKeys, "digestOf">;
  clock: Clock;
};

// a key login that no longer holds, ended once the write rolled back
class KeyLoginEnded extends Unauthorized {
  constructor(readonly login: Login) {
    super();
  }
}

// the caller's user as it stands now; call it inside the transaction,
// through actingWrite() so a key login found ended is deleted
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
  if (!loginHolds(deps.adminKeys, login, user)) throw new KeyLoginEnded(login);
  if (user.disabled) throw new Forbidden();
  if (role === "admin" && user.role !== "admin") throw new Forbidden();
  return user;
}

// a write that reads its caller first; a key login that no longer holds
// is deleted in a transaction of its own, so the refused write writes
// nothing and the login stays gone
export function actingWrite<T>(
  deps: ActingDeps,
  principal: Principal,
  role: "admin" | null,
  body: (user: UserRow) => Transaction<T>,
): T {
  try {
    return transact(deps.db, () => body(actingUser(deps, principal, role)));
  } catch (err) {
    if (err instanceof KeyLoginEnded) {
      const login = err.login;
      transact(deps.db, () => {
        deps.logins.delete(login.id);
        return {
          result: undefined,
          events: [loginRevoked(login.userId, login.id)],
        };
      });
    }
    throw err;
  }
}
