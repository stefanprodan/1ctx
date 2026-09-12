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
import { api } from "./api.ts";
import { me } from "./me.ts";

export const profile = signal<Profile | null>(null);
export const profileError = signal<string | null>(null);

function settle(user: Profile): void {
  if (me.value?.id !== user.id) return;
  profile.value = user;
  const { createdAt: _, about: __, ...summary } = user;
  me.value = summary;
}

export async function loadProfile(): Promise<void> {
  profileError.value = null;
  if (profile.value !== null && profile.value.id !== me.value?.id) {
    profile.value = null;
  }
  try {
    const { user } = await api<ProfileResponse>("/api/profile");
    settle(user);
  } catch (err) {
    profileError.value = err instanceof Error ? err.message : String(err);
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
