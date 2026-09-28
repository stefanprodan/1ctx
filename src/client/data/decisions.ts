// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { effect, signal } from "@preact/signals";
import type {
  DecisionResponse,
  DecisionsResponse,
  SaveDecisionRequest,
} from "../../shared/api/decisions.ts";
import type {
  DecisionId,
  DecisionSummary,
} from "../../shared/contracts/decision.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const decisions = signal<DecisionSummary[] | null>(null);
export const decisionsError = signal<Failure | null>(null);

let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  decisions.value = null;
  decisionsError.value = null;
});

let turn = 0;

export async function loadDecisions(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  decisionsError.value = null;
  try {
    const body = await api<DecisionsResponse>("/api/decisions");
    if (owner === forUser && turn === mine) decisions.value = body.decisions;
  } catch (err) {
    if (owner === forUser && turn === mine) decisionsError.value = failure(err);
  }
}

export async function saveDecision(
  id: DecisionId,
  body: SaveDecisionRequest,
): Promise<DecisionSummary> {
  const forUser = owner;
  const { decision } = await api<DecisionResponse>(
    `/api/decisions/${encodeURIComponent(id)}`,
    "PUT",
    body,
  );
  turn++;
  if (owner === forUser) {
    decisions.value = (decisions.value ?? []).map((d) =>
      d.id === id ? decision : d,
    );
  }
  return decision;
}
