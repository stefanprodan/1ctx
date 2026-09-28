// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

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
import { usageSlot } from "./slot.ts";

export const deciders = signal<DeciderSummary[] | null>(null);
export const decidersError = signal<Failure | null>(null);

let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  deciders.value = null;
  decidersError.value = null;
});

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

export const deciderUsage = usageSlot<DecisionUsageResponse>(
  (id) => `${path(id)}/usage`,
);
export const loadDeciderUsage = deciderUsage.load;

export const decisionUsage = usageSlot<DecisionUsageResponse>(
  (id) => `/api/decisions/${encodeURIComponent(id)}/usage`,
);
export const loadDecisionUsage = decisionUsage.load;
