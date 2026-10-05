// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Directory's three lists, each read whole on every visit, then a
// user's, an agent's and a decider's page: one of each on screen, and
// the pages seen before held by name so going back draws at once while
// they load again. A load's answer is kept only while it is the latest
// asked for, and all go when the signed-in user changes. A page's days
// are their own load, so a page draws before its heatmap.

import { effect, signal } from "@preact/signals";
import type {
  DirectoryAgentDaysResponse,
  DirectoryAgentResponse,
  DirectoryAgentsResponse,
  DirectoryDeciderDaysResponse,
  DirectoryDeciderResponse,
  DirectoryDecidersResponse,
  DirectoryUserDaysResponse,
  DirectoryUserResponse,
  DirectoryUsersResponse,
} from "../../shared/api/directory.ts";
import { type Failure, failure } from "../lib/format.ts";
import { browserZone } from "../lib/zone.ts";
import { api } from "./api.ts";
import { Held } from "./held.ts";
import { me } from "./me.ts";

export const directoryUsers = signal<DirectoryUsersResponse["users"] | null>(
  null,
);
export const directoryUsersError = signal<Failure | null>(null);
export const directoryAgents = signal<DirectoryAgentsResponse["agents"] | null>(
  null,
);
export const directoryAgentsError = signal<Failure | null>(null);
export const userPage = signal<DirectoryUserResponse | null>(null);
export const userPageError = signal<Failure | null>(null);
// the days of the user named in username; failed as the agent's are
export const userDays = signal<{
  username: string;
  body: DirectoryUserDaysResponse;
} | null>(null);
export const userDaysFailed = signal(false);
export const agentPage = signal<DirectoryAgentResponse | null>(null);
export const agentPageError = signal<Failure | null>(null);
// the days of the agent named in name; failed when their load failed
// with none held, so the page leaves the heatmap out
export const agentDays = signal<{
  name: string;
  body: DirectoryAgentDaysResponse;
} | null>(null);
export const agentDaysFailed = signal(false);
export const directoryDeciders = signal<
  DirectoryDecidersResponse["deciders"] | null
>(null);
export const directoryDecidersError = signal<Failure | null>(null);
export const deciderPage = signal<DirectoryDeciderResponse | null>(null);
export const deciderPageError = signal<Failure | null>(null);
// the days of the decider named in name; failed as the agent's are
export const deciderDays = signal<{
  name: string;
  body: DirectoryDeciderDaysResponse;
} | null>(null);
export const deciderDaysFailed = signal(false);

let owner: string | null = null;
let usersTurn = 0;
let agentsTurn = 0;
let userTurn = 0;
let userDaysTurn = 0;
let agentTurn = 0;
let daysTurn = 0;
let decidersTurn = 0;
let deciderTurn = 0;
let deciderDaysTurn = 0;
const userPages = new Held<DirectoryUserResponse>();
const userDaysHeld = new Held<DirectoryUserDaysResponse>();
const agentPages = new Held<DirectoryAgentResponse>();
const agentDaysHeld = new Held<DirectoryAgentDaysResponse>();
const deciderPages = new Held<DirectoryDeciderResponse>();
const deciderDaysHeld = new Held<DirectoryDeciderDaysResponse>();

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  usersTurn++;
  agentsTurn++;
  directoryUsers.value = null;
  directoryUsersError.value = null;
  directoryAgents.value = null;
  directoryAgentsError.value = null;
  userTurn++;
  userDaysTurn++;
  agentTurn++;
  daysTurn++;
  userPage.value = null;
  userPageError.value = null;
  userDays.value = null;
  userDaysFailed.value = false;
  agentPage.value = null;
  agentPageError.value = null;
  agentDays.value = null;
  agentDaysFailed.value = false;
  userPages.clear();
  userDaysHeld.clear();
  agentPages.clear();
  agentDaysHeld.clear();
  decidersTurn++;
  deciderTurn++;
  deciderDaysTurn++;
  directoryDeciders.value = null;
  directoryDecidersError.value = null;
  deciderPage.value = null;
  deciderPageError.value = null;
  deciderDays.value = null;
  deciderDaysFailed.value = false;
  deciderPages.clear();
  deciderDaysHeld.clear();
});

export async function loadDirectoryUsers(): Promise<void> {
  const turn = ++usersTurn;
  directoryUsersError.value = null;
  try {
    const body = await api<DirectoryUsersResponse>("/api/directory/users");
    if (turn !== usersTurn) return;
    directoryUsers.value = body.users;
  } catch (err) {
    if (turn !== usersTurn) return;
    // a refresh that fails keeps the list on screen
    if (directoryUsers.value === null) directoryUsersError.value = failure(err);
  }
}

export async function loadDirectoryAgents(): Promise<void> {
  const turn = ++agentsTurn;
  directoryAgentsError.value = null;
  try {
    const body = await api<DirectoryAgentsResponse>("/api/directory/agents");
    if (turn !== agentsTurn) return;
    directoryAgents.value = body.agents;
  } catch (err) {
    if (turn !== agentsTurn) return;
    if (directoryAgents.value === null) {
      directoryAgentsError.value = failure(err);
    }
  }
}

export async function loadUserPage(username: string): Promise<void> {
  const turn = ++userTurn;
  userPageError.value = null;
  if (userPage.value?.user.username !== username) {
    userPage.value = userPages.get(username) ?? null;
  }
  try {
    const body = await api<DirectoryUserResponse>(
      `/api/directory/users/${encodeURIComponent(username)}`,
    );
    if (turn !== userTurn) return;
    userPages.set(username, body);
    userPage.value = body;
  } catch (err) {
    if (turn !== userTurn) return;
    userPages.delete(username);
    userPage.value = null;
    userPageError.value = failure(err);
  }
}

export async function loadUserDays(username: string): Promise<void> {
  const turn = ++userDaysTurn;
  userDaysFailed.value = false;
  if (userDays.value?.username !== username) {
    const held = userDaysHeld.get(username);
    userDays.value = held === undefined ? null : { username, body: held };
  }
  try {
    const body = await api<DirectoryUserDaysResponse>(
      // the user's own days, in their zone
      `/api/directory/users/${encodeURIComponent(username)}/days`,
    );
    if (turn !== userDaysTurn) return;
    userDaysHeld.set(username, body);
    userDays.value = { username, body };
  } catch {
    if (turn !== userDaysTurn) return;
    // a held copy goes, so a new user given the name never draws the
    // old one's days; a refresh that fails keeps the heatmap on screen
    userDaysHeld.delete(username);
    if (userDays.value?.username !== username) userDaysFailed.value = true;
  }
}

export async function loadAgentPage(name: string): Promise<void> {
  const turn = ++agentTurn;
  agentPageError.value = null;
  if (agentPage.value?.agent.name !== name) {
    agentPage.value = agentPages.get(name) ?? null;
  }
  try {
    const body = await api<DirectoryAgentResponse>(
      `/api/directory/agents/${encodeURIComponent(name)}`,
    );
    if (turn !== agentTurn) return;
    agentPages.set(name, body);
    agentPage.value = body;
  } catch (err) {
    if (turn !== agentTurn) return;
    agentPages.delete(name);
    agentPage.value = null;
    agentPageError.value = failure(err);
  }
}

export async function loadAgentDays(name: string): Promise<void> {
  const turn = ++daysTurn;
  agentDaysFailed.value = false;
  if (agentDays.value?.name !== name) {
    const held = agentDaysHeld.get(name);
    agentDays.value = held === undefined ? null : { name, body: held };
  }
  try {
    const body = await api<DirectoryAgentDaysResponse>(
      `/api/directory/agents/${encodeURIComponent(name)}/days?tz=${encodeURIComponent(browserZone())}`,
    );
    if (turn !== daysTurn) return;
    agentDaysHeld.set(name, body);
    agentDays.value = { name, body };
  } catch {
    if (turn !== daysTurn) return;
    // a held copy goes, so a new agent given the name never draws the
    // old one's days; a refresh that fails keeps the heatmap on screen
    agentDaysHeld.delete(name);
    if (agentDays.value?.name !== name) agentDaysFailed.value = true;
  }
}

export async function loadDirectoryDeciders(): Promise<void> {
  const turn = ++decidersTurn;
  directoryDecidersError.value = null;
  try {
    const body = await api<DirectoryDecidersResponse>(
      "/api/directory/deciders",
    );
    if (turn !== decidersTurn) return;
    directoryDeciders.value = body.deciders;
  } catch (err) {
    if (turn !== decidersTurn) return;
    if (directoryDeciders.value === null) {
      directoryDecidersError.value = failure(err);
    }
  }
}

export async function loadDeciderPage(name: string): Promise<void> {
  const turn = ++deciderTurn;
  deciderPageError.value = null;
  if (deciderPage.value?.decider.name !== name) {
    deciderPage.value = deciderPages.get(name) ?? null;
  }
  try {
    const body = await api<DirectoryDeciderResponse>(
      `/api/directory/deciders/${encodeURIComponent(name)}`,
    );
    if (turn !== deciderTurn) return;
    deciderPages.set(name, body);
    deciderPage.value = body;
  } catch (err) {
    if (turn !== deciderTurn) return;
    deciderPages.delete(name);
    deciderPage.value = null;
    deciderPageError.value = failure(err);
  }
}

export async function loadDeciderDays(name: string): Promise<void> {
  const turn = ++deciderDaysTurn;
  deciderDaysFailed.value = false;
  if (deciderDays.value?.name !== name) {
    const held = deciderDaysHeld.get(name);
    deciderDays.value = held === undefined ? null : { name, body: held };
  }
  try {
    const body = await api<DirectoryDeciderDaysResponse>(
      `/api/directory/deciders/${encodeURIComponent(name)}/days?tz=${encodeURIComponent(browserZone())}`,
    );
    if (turn !== deciderDaysTurn) return;
    deciderDaysHeld.set(name, body);
    deciderDays.value = { name, body };
  } catch {
    if (turn !== deciderDaysTurn) return;
    // as the agent's: a held copy goes, a refresh that fails keeps the
    // heatmap on screen
    deciderDaysHeld.delete(name);
    if (deciderDays.value?.name !== name) deciderDaysFailed.value = true;
  }
}
