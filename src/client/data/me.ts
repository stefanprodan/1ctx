// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The signed-in user: the one entity every view reads. Undefined until
// the first load answers, null when nobody is signed in. A load that
// fails leaves me undefined and sets the error so the root can offer a
// retry instead of a blank page.

import { signal } from "@preact/signals";
import type {
  LoginRequest,
  LoginResponse,
  MeResponse,
} from "../../shared/api/access.ts";
import type { UserSummary } from "../../shared/contracts/user.ts";
import { api, onUnauthorized } from "./api.ts";

export const me = signal<UserSummary | null | undefined>(undefined);
export const meError = signal<string | null>(null);

// any 401 means the login behind the cookie is gone
onUnauthorized(() => {
  if (me.value) me.value = null;
});

export async function loadMe(): Promise<void> {
  meError.value = null;
  try {
    const { user } = await api<MeResponse>("/api/me");
    me.value = user;
  } catch (err) {
    meError.value = err instanceof Error ? err.message : String(err);
  }
}

export async function login(body: LoginRequest): Promise<void> {
  const { user } = await api<LoginResponse>("/api/login", "POST", body);
  me.value = user;
}

// a 401 here means the login was already gone: signed out either way
export async function logout(): Promise<void> {
  try {
    await api("/api/logout", "POST");
  } catch (err) {
    if (!(err instanceof Error && "status" in err && err.status === 401)) {
      throw err;
    }
  }
  me.value = null;
}
