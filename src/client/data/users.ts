// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { effect, signal } from "@preact/signals";
import type { SendTotalsResponse } from "../../shared/api/admin.ts";
import type {
  AdminUser,
  CreateUserRequest,
  ResetPasswordRequest,
  UpdateUserRequest,
  UserResponse,
  UsersResponse,
} from "../../shared/api/users.ts";
import { type Failure, failure } from "../lib/format.ts";
import {
  addProjectMember,
  onProjectMembers,
  removeProjectMember,
} from "./admin-projects.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";
import { usageSlot } from "./slot.ts";

export const users = signal<AdminUser[] | null>(null);
export const usersError = signal<Failure | null>(null);
// email is set up, so a placeholder address is said as one
export const emailOn = signal(false);
export const userUsage = usageSlot<SendTotalsResponse>(
  (id) => `/api/users/${encodeURIComponent(id)}/usage`,
);
export const loadUserUsage = userUsage.load;

let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  users.value = null;
  usersError.value = null;
  emailOn.value = false;
});

onProjectMembers((projectId, memberIds) => {
  if (users.value === null) return;
  users.value = users.value.map((u) => {
    const has = u.projectIds.includes(projectId);
    const is = memberIds.includes(u.id);
    if (has === is) return u;
    return {
      ...u,
      projectIds: is
        ? [...u.projectIds, projectId]
        : u.projectIds.filter((id) => id !== projectId),
    };
  });
});

// the server's order, so a rename moves the row where a reload would
const byUsername = (a: AdminUser, b: AdminUser) =>
  a.username < b.username ? -1 : a.username > b.username ? 1 : 0;

// a write that lands drops a load in flight, whose answer is older
let turn = 0;

export async function loadUsers(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  usersError.value = null;
  try {
    const body = await api<UsersResponse>("/api/users");
    if (owner === forUser && turn === mine) {
      users.value = body.users;
      emailOn.value = body.emailOn;
    }
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

// a reset answers no row but sets mustChangePassword on one
export async function resetPassword(
  id: string,
  body: ResetPasswordRequest,
): Promise<void> {
  await api(`/api/users/${encodeURIComponent(id)}/password`, "POST", body);
  await reread();
}

// a failure is the saving card's, since the page keeps the list it has
async function reread(): Promise<void> {
  await loadUsers();
  const failed = usersError.value;
  if (failed !== null) throw new Error(failed.words);
}

// each call answers the project, not the user, so the list is read again
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
  if (failed === null) return reread();
  // the calls before the refusal landed
  await loadUsers();
  throw failed;
}
