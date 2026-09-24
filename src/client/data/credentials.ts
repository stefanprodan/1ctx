// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The HTTP credentials entity: the admin's list with the http- key files
// the form may pick, loaded when the Tools page's Web tab is reached and
// dropped with the signed-in user, and the calls that change it. A write
// puts the server's row in the list, so what shows is what was saved.

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
import { api } from "./api.ts";
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
  turn++;
  credentials.value = null;
  credentialKeys.value = [];
  credentialsError.value = null;
});

const byName = (rows: CredentialSummary[]) =>
  rows.slice().sort((a, b) => a.name.localeCompare(b.name));

// a load's answer is kept only when it is still the one wanted: for the
// signed-in user of the moment and the latest word on the list
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
  turn++;
  const answer = await api<CredentialResponse>(
    "/api/credentials",
    "POST",
    body,
  );
  if (owner !== forUser) return answer.credential;
  turn++;
  return keep(answer);
}

export async function patchCredential(
  id: string,
  body: PatchCredentialRequest,
): Promise<CredentialSummary> {
  const forUser = owner;
  turn++;
  const answer = await api<CredentialResponse>(
    `/api/credentials/${encodeURIComponent(id)}`,
    "PATCH",
    body,
  );
  if (owner !== forUser) return answer.credential;
  turn++;
  return keep(answer);
}

export async function deleteCredential(id: string): Promise<void> {
  const forUser = owner;
  turn++;
  await api(`/api/credentials/${encodeURIComponent(id)}`, "DELETE");
  if (owner === forUser) {
    turn++;
    credentials.value = (credentials.value ?? []).filter((c) => c.id !== id);
  }
}
