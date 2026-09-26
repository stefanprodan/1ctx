// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user's page and an agent's page: one of each on screen, and the
// pages seen before held by name so going back draws at once while
// they load again. A load's answer is kept only while it is the latest
// asked for, and all go when the signed-in user changes. The agent's
// days are their own load, so the page draws before its heatmap.

import { effect, signal } from "@preact/signals";
import type {
  DirectoryAgentDaysResponse,
  DirectoryAgentResponse,
  DirectoryUserResponse,
} from "../../shared/api/directory.ts";
import { type Failure, failure } from "../lib/format.ts";
import { browserZone } from "../lib/zone.ts";
import { api } from "./api.ts";
import { Held } from "./held.ts";
import { me } from "./me.ts";

export const person = signal<DirectoryUserResponse | null>(null);
export const personError = signal<Failure | null>(null);
export const agentPage = signal<DirectoryAgentResponse | null>(null);
export const agentPageError = signal<Failure | null>(null);
// the days of the agent named in name; failed when their load failed
// with none held, so the page leaves the heatmap out
export const agentDays = signal<{
  name: string;
  body: DirectoryAgentDaysResponse;
} | null>(null);
export const agentDaysFailed = signal(false);

let owner: string | null = null;
let personTurn = 0;
let agentTurn = 0;
let daysTurn = 0;
const people = new Held<DirectoryUserResponse>();
const agents = new Held<DirectoryAgentResponse>();
const agentsDays = new Held<DirectoryAgentDaysResponse>();

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  personTurn++;
  agentTurn++;
  daysTurn++;
  person.value = null;
  personError.value = null;
  agentPage.value = null;
  agentPageError.value = null;
  agentDays.value = null;
  agentDaysFailed.value = false;
  people.clear();
  agents.clear();
  agentsDays.clear();
});

export async function loadPerson(username: string): Promise<void> {
  const turn = ++personTurn;
  personError.value = null;
  if (person.value?.user.username !== username) {
    person.value = people.get(username) ?? null;
  }
  try {
    const body = await api<DirectoryUserResponse>(
      `/api/directory/users/${encodeURIComponent(username)}`,
    );
    if (turn !== personTurn) return;
    people.set(username, body);
    person.value = body;
  } catch (err) {
    if (turn !== personTurn) return;
    people.delete(username);
    person.value = null;
    personError.value = failure(err);
  }
}

export async function loadAgentPage(name: string): Promise<void> {
  const turn = ++agentTurn;
  agentPageError.value = null;
  if (agentPage.value?.agent.name !== name) {
    agentPage.value = agents.get(name) ?? null;
  }
  try {
    const body = await api<DirectoryAgentResponse>(
      `/api/directory/agents/${encodeURIComponent(name)}`,
    );
    if (turn !== agentTurn) return;
    agents.set(name, body);
    agentPage.value = body;
  } catch (err) {
    if (turn !== agentTurn) return;
    agents.delete(name);
    agentPage.value = null;
    agentPageError.value = failure(err);
  }
}

export async function loadAgentDays(name: string): Promise<void> {
  const turn = ++daysTurn;
  agentDaysFailed.value = false;
  if (agentDays.value?.name !== name) {
    const held = agentsDays.get(name);
    agentDays.value = held === undefined ? null : { name, body: held };
  }
  try {
    const body = await api<DirectoryAgentDaysResponse>(
      `/api/directory/agents/${encodeURIComponent(name)}/days?tz=${encodeURIComponent(browserZone())}`,
    );
    if (turn !== daysTurn) return;
    agentsDays.set(name, body);
    agentDays.value = { name, body };
  } catch {
    if (turn !== daysTurn) return;
    // a held copy goes, so a new agent given the name never draws the
    // old one's days; a refresh that fails keeps the heatmap on screen
    agentsDays.delete(name);
    if (agentDays.value?.name !== name) agentDaysFailed.value = true;
  }
}
