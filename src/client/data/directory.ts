// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user's page and an agent's page: one of each held at a time, the one
// on screen. A load's answer is kept only while it is the latest asked
// for, and both go when the signed-in user changes.

import { effect, signal } from "@preact/signals";
import type {
  DirectoryAgentResponse,
  DirectoryUserResponse,
} from "../../shared/api/directory.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const person = signal<DirectoryUserResponse | null>(null);
export const personError = signal<Failure | null>(null);
export const agentPage = signal<DirectoryAgentResponse | null>(null);
export const agentPageError = signal<Failure | null>(null);

let owner: string | null = null;
let personTurn = 0;
let agentTurn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  personTurn++;
  agentTurn++;
  person.value = null;
  personError.value = null;
  agentPage.value = null;
  agentPageError.value = null;
});

export async function loadPerson(username: string): Promise<void> {
  const turn = ++personTurn;
  personError.value = null;
  if (person.value !== null && person.value.user.username !== username) {
    person.value = null;
  }
  try {
    const body = await api<DirectoryUserResponse>(
      `/api/directory/users/${encodeURIComponent(username)}`,
    );
    if (turn === personTurn) person.value = body;
  } catch (err) {
    if (turn === personTurn) personError.value = failure(err);
  }
}

export async function loadAgentPage(name: string): Promise<void> {
  const turn = ++agentTurn;
  agentPageError.value = null;
  if (agentPage.value !== null && agentPage.value.agent.name !== name) {
    agentPage.value = null;
  }
  try {
    const body = await api<DirectoryAgentResponse>(
      `/api/directory/agents/${encodeURIComponent(name)}`,
    );
    if (turn === agentTurn) agentPage.value = body;
  } catch (err) {
    if (turn === agentTurn) agentPageError.value = failure(err);
  }
}
