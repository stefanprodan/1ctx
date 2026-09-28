// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The users entity: the admin's list, loaded when its page is reached
// and dropped with the signed-in user, and the calls that change it. A
// write puts the server's row in the list, so what shows is what was
// saved; a reset answers nothing and reads the list again. A user's
// page reads its aside's usage apart.

import { effect, signal } from "@preact/signals";
import type {
  AdminUser,
  CreateUserRequest,
  ResetPasswordRequest,
  UpdateUserRequest,
  UserResponse,
  UsersResponse,
  UserUsageResponse,
} from "../../shared/api/users.ts";
import { type Failure, failure } from "../lib/format.ts";
import { addProjectMember, removeProjectMember } from "./admin-projects.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const users = signal<AdminUser[] | null>(null);
export const usersError = signal<Failure | null>(null);
// the user pages' asides by user id, null for a read that failed, so
// an answer for one user never hides another's
export const userUsage = signal<Record<string, UserUsageResponse | null>>({});

let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  users.value = null;
  usersError.value = null;
  userUsage.value = {};
});

// the list is kept by username, the server's order, so a rename moves
// the row where a reload would put it
const byUsername = (a: AdminUser, b: AdminUser) =>
  a.username < b.username ? -1 : a.username > b.username ? 1 : 0;

// a load's answer is kept only when it is still the one wanted: for
// the signed-in user of the moment and the latest word on the list, a
// failure included, since a route arrival reloads and a write can land
// while a load is in flight
let turn = 0;

export async function loadUsers(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  usersError.value = null;
  try {
    const body = await api<UsersResponse>("/api/users");
    if (owner === forUser && turn === mine) users.value = body.users;
  } catch (err) {
    if (owner === forUser && turn === mine) usersError.value = failure(err);
  }
}

export async function createUser(body: CreateUserRequest): Promise<AdminUser> {
  const forUser = owner;
  const { user } = await api<UserResponse>("/api/users", "POST", body);
  turn++;
  if (owner === forUser) {
    users.value = [...(users.value ?? []), user].sort(byUsername);
  }
  return user;
}

export async function updateUser(
  id: string,
  body: UpdateUserRequest,
): Promise<AdminUser> {
  const forUser = owner;
  const { user } = await api<UserResponse>(
    `/api/users/${encodeURIComponent(id)}`,
    "PATCH",
    body,
  );
  turn++;
  if (owner === forUser) {
    users.value = (users.value ?? [])
      .map((u) => (u.id === id ? user : u))
      .sort(byUsername);
  }
  return user;
}

// a reset answers no row, and it changes one: the person now has a
// password to change, so the list is read again
export async function resetPassword(
  id: string,
  body: ResetPasswordRequest,
): Promise<void> {
  await api(`/api/users/${encodeURIComponent(id)}/password`, "POST", body);
  await reread();
}

// the list again after a write that answers no row; a failure is the
// saving card's, since the page keeps the list it has
async function reread(): Promise<void> {
  await loadUsers();
  const failed = usersError.value;
  if (failed !== null) throw new Error(failed.words);
}

// the team projects a user is in, as the page's card drafted them: one
// call per project added or removed, then the list again, since each
// answers the project and not the user
export async function setUserProjects(
  user: AdminUser,
  projectIds: string[],
): Promise<void> {
  let failed: unknown = null;
  try {
    for (const id of projectIds) {
      if (!user.projectIds.includes(id)) {
        await addProjectMember(id, { userId: user.id });
      }
    }
    for (const id of user.projectIds) {
      if (!projectIds.includes(id)) await removeProjectMember(id, user.id);
    }
  } catch (err) {
    failed = err;
  }
  // the list again either way, since the calls before a refusal landed;
  // the refusal is what the card says
  await loadUsers();
  if (failed !== null) throw failed;
  const reread = usersError.value;
  if (reread !== null) throw new Error(reread.words);
}

// a failure is the aside's "Did not load", never the page's; each
// answer lands under its own user, for the signed-in user who asked
export async function loadUserUsage(id: string): Promise<void> {
  const forUser = owner;
  let usage: UserUsageResponse | null = null;
  try {
    usage = await api<UserUsageResponse>(
      `/api/users/${encodeURIComponent(id)}/usage`,
    );
  } catch {}
  if (owner === forUser) userUsage.value = { ...userUsage.value, [id]: usage };
}
