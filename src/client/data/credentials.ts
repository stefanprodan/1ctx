// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { effect, signal } from "@preact/signals";
import type {
  CreateCredentialRequest,
  CredentialKey,
  CredentialResponse,
  CredentialsResponse,
  PatchCredentialRequest,
} from "../../shared/api/credentials.ts";
import type { CredentialSummary } from "../../shared/contracts/credential.ts";
import { type Failure, failure } from "../lib/format.ts";
import { byName } from "../lib/search.ts";
import { ApiError, api } from "./api.ts";
import { me } from "./me.ts";

export const credentials = signal<CredentialSummary[] | null>(null);
export const credentialKeys = signal<CredentialKey[]>([]);
export const credentialsError = signal<Failure | null>(null);

let owner: string | null = null;
let turn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  credentials.value = null;
  credentialKeys.value = [];
  credentialsError.value = null;
});

export async function loadCredentials(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  credentialsError.value = null;
  try {
    const body = await api<CredentialsResponse>("/api/credentials");
    if (owner === forUser && turn === mine) {
      credentials.value = byName(body.credentials);
      credentialKeys.value = body.keys;
    }
  } catch (err) {
    if (owner === forUser && turn === mine) {
      credentialsError.value = failure(err);
    }
  }
}

function keep(answer: CredentialResponse): CredentialSummary {
  const { credential } = answer;
  credentials.value = byName([
    ...(credentials.value ?? []).filter((c) => c.id !== credential.id),
    credential,
  ]);
  return credential;
}

export async function addCredential(
  body: CreateCredentialRequest,
): Promise<CredentialSummary> {
  const forUser = owner;
  const answer = await api<CredentialResponse>(
    "/api/credentials",
    "POST",
    body,
  );
  if (owner !== forUser) return answer.credential;
  turn++;
  return keep(answer);
}

// a 404: another tab deleted it, so the page says it is gone
async function gone<T>(id: string, call: () => Promise<T>): Promise<T> {
  const forUser = owner;
  try {
    return await call();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404 && owner === forUser) {
      turn++;
      credentials.value = (credentials.value ?? []).filter((c) => c.id !== id);
    }
    throw err;
  }
}

export async function patchCredential(
  id: string,
  body: PatchCredentialRequest,
): Promise<CredentialSummary> {
  const forUser = owner;
  const answer = await gone(id, () =>
    api<CredentialResponse>(
      `/api/credentials/${encodeURIComponent(id)}`,
      "PATCH",
      body,
    ),
  );
  if (owner !== forUser) return answer.credential;
  // a delete that landed first keeps the row out
  if (!(credentials.value ?? []).some((c) => c.id === id)) {
    return answer.credential;
  }
  turn++;
  return keep(answer);
}

// a row already gone is what a delete wants: no refusal
export async function deleteCredential(id: string): Promise<void> {
  const forUser = owner;
  try {
    await api(`/api/credentials/${encodeURIComponent(id)}`, "DELETE");
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  if (owner === forUser) {
    turn++;
    credentials.value = (credentials.value ?? []).filter((c) => c.id !== id);
  }
}
