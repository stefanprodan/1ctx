// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The signed-in user's own page: loaded on demand, and every write to
// it answers the fresh row, which also updates me so the rail follows.
// A row is kept only while it is the signed-in user's: a load that
// answers after a sign out, or after someone else signed in, is dropped,
// and a row left by the previous user goes before the next load.

import { signal } from "@preact/signals";
import type {
  ChangePasswordRequest,
  ProfileResponse,
  UpdateProfileRequest,
} from "../../shared/api/profile.ts";
import type { Profile } from "../../shared/contracts/user.ts";
import { reason } from "../lib/format.ts";
import { api } from "./api.ts";
import { me, setMe } from "./me.ts";

export const profile = signal<Profile | null>(null);
export const profileError = signal<string | null>(null);

// a load's answer is kept only while it is the latest word on the row:
// a later load, or a write, supersedes it, since a route arrival
// reloads and a save can land while one is in flight
let turn = 0;

function settle(user: Profile): void {
  if (me.value?.id !== user.id) return;
  turn++;
  profile.value = user;
  setMe({
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  });
}

export async function loadProfile(): Promise<void> {
  const mine = ++turn;
  profileError.value = null;
  if (profile.value !== null && profile.value.id !== me.value?.id) {
    profile.value = null;
  }
  try {
    const { user } = await api<ProfileResponse>("/api/profile");
    if (turn === mine) settle(user);
  } catch (err) {
    if (turn === mine) {
      profileError.value = reason(err);
    }
  }
}

export async function saveProfile(body: UpdateProfileRequest): Promise<void> {
  const { user } = await api<ProfileResponse>("/api/profile", "PATCH", body);
  settle(user);
}

export async function changePassword(
  body: ChangePasswordRequest,
): Promise<void> {
  const { user } = await api<ProfileResponse>(
    "/api/profile/password",
    "POST",
    body,
  );
  settle(user);
}
