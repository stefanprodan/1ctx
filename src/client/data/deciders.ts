// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The deciders entity: the admin's list, loaded with its pages and
// dropped with the signed-in user, and the calls that change it. A
// write puts the server's row in the list, so what shows is what was
// saved. A check's answer belongs to the card that asked, not here. A
// decider's and a decision's last 30 days are here too, both answered
// by the deciders routes.

import { effect, signal } from "@preact/signals";
import type {
  CheckDeciderResponse,
  DeciderResponse,
  DecidersResponse,
  DecisionUsageResponse,
  SaveDeciderRequest,
} from "../../shared/api/deciders.ts";
import type { DeciderSummary } from "../../shared/contracts/decider.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const deciders = signal<DeciderSummary[] | null>(null);
export const decidersError = signal<Failure | null>(null);
// the last 30 days a page's aside shows, for the decider or the
// decision it was read for; usage is null when the read failed
export type UsageOf = {
  of: string;
  usage: DecisionUsageResponse | null;
} | null;
export const deciderUsage = signal<UsageOf>(null);
export const decisionUsage = signal<UsageOf>(null);

let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  deciders.value = null;
  decidersError.value = null;
  deciderUsage.value = null;
  decisionUsage.value = null;
});

// a load's answer is kept only when it is still the latest word on the
// list for the same user, as the agents' is
let turn = 0;

export async function loadDeciders(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  decidersError.value = null;
  try {
    const body = await api<DecidersResponse>("/api/deciders");
    if (owner === forUser && turn === mine) deciders.value = body.deciders;
  } catch (err) {
    if (owner === forUser && turn === mine) decidersError.value = failure(err);
  }
}

const path = (id: string) => `/api/deciders/${encodeURIComponent(id)}`;

export async function createDecider(
  body: SaveDeciderRequest,
): Promise<DeciderSummary> {
  const forUser = owner;
  const { decider } = await api<DeciderResponse>("/api/deciders", "POST", body);
  turn++;
  if (owner === forUser) deciders.value = [...(deciders.value ?? []), decider];
  if (body.default !== undefined) void loadDeciders();
  return decider;
}

export async function updateDecider(
  id: string,
  body: SaveDeciderRequest,
): Promise<DeciderSummary> {
  const forUser = owner;
  const { decider } = await api<DeciderResponse>(path(id), "PATCH", body);
  turn++;
  if (owner === forUser) {
    deciders.value = (deciders.value ?? []).map((d) =>
      d.id === id ? decider : d,
    );
  }
  // the mark moved, so another row's default changed with it
  if (body.default !== undefined) void loadDeciders();
  return decider;
}

export async function deleteDecider(id: string): Promise<void> {
  const forUser = owner;
  const wasDefault = deciders.value?.find((d) => d.id === id)?.default ?? false;
  await api(path(id), "DELETE");
  turn++;
  if (owner === forUser) {
    deciders.value = (deciders.value ?? []).filter((d) => d.id !== id);
  }
  // the oldest left is the default now
  if (wasDefault) void loadDeciders();
}

export const checkDecider = (id: string): Promise<CheckDeciderResponse> =>
  api<CheckDeciderResponse>(`${path(id)}/check`, "POST");

// a failure is the aside's "Did not load", never the page's
async function readUsage(
  url: string,
  of: string,
  into: typeof deciderUsage,
): Promise<void> {
  const forUser = owner;
  let usage: DecisionUsageResponse | null = null;
  try {
    usage = await api<DecisionUsageResponse>(url);
  } catch {}
  if (owner === forUser) into.value = { of, usage };
}

export const loadDeciderUsage = (id: string): Promise<void> =>
  readUsage(`${path(id)}/usage`, id, deciderUsage);

export const loadDecisionUsage = (id: string): Promise<void> =>
  readUsage(
    `/api/decisions/${encodeURIComponent(id)}/usage`,
    id,
    decisionUsage,
  );
