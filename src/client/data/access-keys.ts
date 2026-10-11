// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Access keys: the signed-in user's own, listed and made on the profile,
// and a user's as an admin sees them on the user's page. A create's
// token is handed to the caller and never kept here, so it goes with the
// view that shows it.

import { effect, signal } from "@preact/signals";
import type {
  AccessKeysResponse,
  CreateAccessKeyRequest,
  CreateAccessKeyResponse,
} from "../../shared/api/profile.ts";
import type { UserAccessKeysResponse } from "../../shared/api/users.ts";
import type { AccessKey } from "../../shared/contracts/access-key.ts";
import { type Failure, failure } from "../lib/format.ts";
import { ApiError, api } from "./api.ts";
import { me } from "./me.ts";
import { readSlot } from "./slot.ts";

export const accessKeys = signal<AccessKey[] | null>(null);
// the admin's cap; 0 turns keys off
export const accessKeysLimit = signal(0);
export const accessKeysError = signal<Failure | null>(null);

let owner: string | null = null;
// one more on every sign in or out, so a write for a sign-in that ended
// never touches the next one, the same user's included
let epoch = 0;
// a write that lands drops a load in flight, whose answer is older
let turn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  epoch++;
  turn++;
  accessKeys.value = null;
  accessKeysLimit.value = 0;
  accessKeysError.value = null;
});

export async function loadAccessKeys(): Promise<void> {
  const forEpoch = epoch;
  const mine = ++turn;
  accessKeysError.value = null;
  try {
    const body = await api<AccessKeysResponse>("/api/profile/keys");
    if (epoch === forEpoch && turn === mine) {
      accessKeys.value = body.keys;
      accessKeysLimit.value = body.limit;
    }
  } catch (err) {
    if (epoch === forEpoch && turn === mine)
      accessKeysError.value = failure(err);
  }
}

// newest first, as the server lists them
export async function createAccessKey(
  body: CreateAccessKeyRequest,
): Promise<CreateAccessKeyResponse> {
  const forEpoch = epoch;
  const made = await api<CreateAccessKeyResponse>(
    "/api/profile/keys",
    "POST",
    body,
  );
  // a write for a user who has since left never drops the next one's load
  if (epoch === forEpoch) {
    turn++;
    accessKeys.value = [
      made.key,
      ...(accessKeys.value ?? []).filter((k) => k.id !== made.key.id),
    ];
  }
  return made;
}

// a 404 is a key already revoked elsewhere, so its row goes too
export async function revokeAccessKey(id: string): Promise<void> {
  const forEpoch = epoch;
  try {
    await api(`/api/profile/keys/${encodeURIComponent(id)}`, "DELETE");
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  if (epoch === forEpoch) {
    turn++;
    if (accessKeys.value !== null) {
      accessKeys.value = accessKeys.value.filter((k) => k.id !== id);
    }
  }
}

// an admin's view of one user's keys, kept per user id
export const userKeys = readSlot((userId: string) =>
  api<UserAccessKeysResponse>(
    `/api/users/${encodeURIComponent(userId)}/keys`,
  ).then((body) => body.keys),
);
export const loadUserKeys = userKeys.load;

// the list is read again whatever the answer, so a key revoked or
// deleted elsewhere goes too
export async function revokeUserKey(
  userId: string,
  keyId: string,
): Promise<void> {
  try {
    await api(
      `/api/users/${encodeURIComponent(userId)}/keys/${encodeURIComponent(keyId)}`,
      "DELETE",
    );
  } finally {
    // a failed reload never hides the revoke's own answer
    await loadUserKeys(userId).catch(() => undefined);
  }
}
