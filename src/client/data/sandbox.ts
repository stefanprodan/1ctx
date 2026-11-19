// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sandbox shell: the admin's setting and the sandboxes the instance
// holds, read again while the page is seen.

import { effect, signal } from "@preact/signals";
import type {
  PutSandboxRequest,
  SandboxLeasesResponse,
  SandboxResponse,
} from "../../shared/api/sandbox.ts";
import type { LeaseRow } from "../../shared/contracts/sandbox.ts";
import { type Failure, failure } from "../lib/format.ts";
import { browserTab, type PollDriver, pollWhileSeen } from "../lib/poll.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const sandbox = signal<SandboxResponse | null>(null);
export const sandboxError = signal<Failure | null>(null);
export const sandboxLeases = signal<LeaseRow[] | null>(null);
export const sandboxLeasesError = signal<Failure | null>(null);
// why every command is refused, from the leases' answer, else null
export const sandboxRefused = signal<string | null>(null);

// a lease moves in seconds; the list is a glance, not a monitor
export const LEASES_EVERY_MS = 15_000;

let owner: string | null = null;
let turn = 0;
let leasesTurn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  sandbox.value = null;
  sandboxError.value = null;
  sandboxLeases.value = null;
  sandboxLeasesError.value = null;
  sandboxRefused.value = null;
});

export async function loadSandbox(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  sandboxError.value = null;
  const leases = loadSandboxLeases();
  try {
    const body = await api<SandboxResponse>("/api/admin/sandbox");
    if (owner === forUser && turn === mine) sandbox.value = body;
  } catch (err) {
    if (owner === forUser && turn === mine) sandboxError.value = failure(err);
  }
  await leases;
}

export async function loadSandboxLeases(): Promise<void> {
  const forUser = owner;
  const mine = ++leasesTurn;
  try {
    const body = await api<SandboxLeasesResponse>("/api/admin/sandbox/leases");
    if (owner !== forUser || leasesTurn !== mine) return;
    sandboxLeases.value = body.leases;
    sandboxRefused.value = body.refused;
    sandboxLeasesError.value = null;
  } catch (err) {
    if (owner === forUser && leasesTurn === mine) {
      sandboxLeasesError.value = failure(err);
      // unknown now: the list says the read failed
      sandboxRefused.value = null;
    }
  }
}

// the answer is the whole setting, so it supersedes a load in flight; a
// new gateway or image drains the old sandboxes, so the list follows
export async function saveSandbox(body: PutSandboxRequest): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  const next = await api<SandboxResponse>("/api/admin/sandbox", "PUT", body);
  if (owner === forUser && turn === mine) sandbox.value = next;
  void loadSandboxLeases();
}

export function watchSandboxLeases(tab: PollDriver = browserTab): () => void {
  return pollWhileSeen(LEASES_EVERY_MS, () => void loadSandboxLeases(), tab);
}
