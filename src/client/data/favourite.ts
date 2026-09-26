// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The signed-in user's favourite agent: what the profile form picks
// from, and the one write the agent page and the form share. A write
// moves the agent a new chat starts on at once, before the composer's
// agents load again.

import { effect, signal } from "@preact/signals";
import type {
  FavouriteAgentResponse,
  SetFavouriteAgentRequest,
} from "../../shared/api/agents.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { agentPage } from "./directory.ts";
import { me } from "./me.ts";
import { pickFavourite } from "./project-agents.ts";

export const favourite = signal<FavouriteAgentResponse | null>(null);
export const favouriteError = signal<Failure | null>(null);

let owner: string | null = null;
let turn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  turn++;
  favourite.value = null;
  favouriteError.value = null;
});

function settle(body: FavouriteAgentResponse): void {
  turn++;
  favourite.value = body;
  pickFavourite(body.agentId ?? body.defaultId);
  const page = agentPage.value;
  if (page !== null) {
    agentPage.value = { ...page, favourite: page.agent.id === body.agentId };
  }
}

export async function loadFavourite(): Promise<void> {
  const mine = ++turn;
  const forUser = owner;
  favouriteError.value = null;
  try {
    const body = await api<FavouriteAgentResponse>("/api/profile/agent");
    if (turn === mine && owner === forUser) settle(body);
  } catch (err) {
    if (turn === mine && owner === forUser) favouriteError.value = failure(err);
  }
}

// null follows the default again
export async function setFavourite(agentId: string | null): Promise<void> {
  const forUser = owner;
  const body: SetFavouriteAgentRequest = { agentId };
  const answer = await api<FavouriteAgentResponse>(
    "/api/profile/agent",
    "PUT",
    body,
  );
  if (owner === forUser) settle(answer);
}
