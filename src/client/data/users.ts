// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The users entity: the admin's list, loaded when its page is reached
// and dropped with the signed-in user, and the calls that change it. A
// write puts the server's row in the list, so what shows is what was
// saved; a reset answers nothing and reads the list again.

import { effect, signal } from "@preact/signals";
import type {
  CreateUserRequest,
  ResetPasswordRequest,
  UpdateUserRequest,
  UserResponse,
  UsersResponse,
} from "../../shared/api/users.ts";
import type { UserAccount } from "../../shared/contracts/user.ts";
import { reason } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const users = signal<UserAccount[] | null>(null);
export const usersError = signal<string | null>(null);

let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  users.value = null;
  usersError.value = null;
});

// the list is kept by username, the server's order, so a rename moves
// the row where a reload would put it
const byUsername = (a: UserAccount, b: UserAccount) =>
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
    if (owner === forUser && turn === mine) usersError.value = reason(err);
  }
}

export async function createUser(
  body: CreateUserRequest,
): Promise<UserAccount> {
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
): Promise<UserAccount> {
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
  await loadUsers();
}
