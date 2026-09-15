// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The skills entity: the admin's list, loaded when its page or the
// agents page is reached and dropped with the signed-in user, and the
// calls that change it. A write puts the server's row in the list, so
// what shows is what was saved. A body and a file are read on open and
// kept beside the list, since the list travels without them; a refresh
// drops what it held of that skill.

import { effect, signal } from "@preact/signals";
import type {
  AddSkillRequest,
  DiscoverResponse,
  SkillFileResponse,
  SkillResponse,
  SkillsResponse,
} from "../../shared/api/skills.ts";
import type { IndexEntry, SkillSummary } from "../../shared/contracts/skill.ts";
import { reason } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const skills = signal<SkillSummary[] | null>(null);
export const skillsError = signal<string | null>(null);
// the bodies read so far, by id, and the files by id and path
export const bodies = signal<Record<string, string>>({});
export const files = signal<Record<string, string>>({});

export const fileKey = (id: string, path: string) => `${id}\n${path}`;

let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  skills.value = null;
  skillsError.value = null;
  bodies.value = {};
  files.value = {};
});

// a load's answer is kept only when it is still the one wanted: for
// the signed-in user of the moment and the latest word on the list, a
// failure included, since a route arrival reloads and a write can land
// while a load is in flight
let turn = 0;

const byName = (rows: SkillSummary[]) =>
  rows.slice().sort((a, b) => a.name.localeCompare(b.name));

export async function loadSkills(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  skillsError.value = null;
  try {
    const body = await api<SkillsResponse>("/api/skills");
    if (owner === forUser && turn === mine) skills.value = byName(body.skills);
  } catch (err) {
    if (owner === forUser && turn === mine) skillsError.value = reason(err);
  }
}

// what a row's write answered: the row into the list, the body beside
// it, and the files it held dropped, since a refresh may have changed
// them
function keep(answer: SkillResponse): void {
  const { skill, body } = answer;
  skills.value = byName([
    ...(skills.value ?? []).filter((s) => s.id !== skill.id),
    skill,
  ]);
  bodies.value = { ...bodies.value, [skill.id]: body };
  const rest: Record<string, string> = {};
  for (const [key, content] of Object.entries(files.value)) {
    if (!key.startsWith(`${skill.id}\n`)) rest[key] = content;
  }
  files.value = rest;
}

export async function addSkill(body: AddSkillRequest): Promise<SkillSummary> {
  const forUser = owner;
  const answer = await api<SkillResponse>("/api/skills", "POST", body);
  turn++;
  if (owner === forUser) keep(answer);
  return answer.skill;
}

export async function refreshSkill(id: string): Promise<SkillSummary> {
  const forUser = owner;
  const answer = await api<SkillResponse>(
    `/api/skills/${encodeURIComponent(id)}/refresh`,
    "POST",
    {},
  );
  turn++;
  if (owner === forUser) keep(answer);
  return answer.skill;
}

export async function deleteSkill(id: string): Promise<void> {
  const forUser = owner;
  await api(`/api/skills/${encodeURIComponent(id)}`, "DELETE");
  turn++;
  if (owner === forUser) {
    skills.value = (skills.value ?? []).filter((s) => s.id !== id);
    const nextBodies = { ...bodies.value };
    delete nextBodies[id];
    bodies.value = nextBodies;
    files.value = Object.fromEntries(
      Object.entries(files.value).filter(([key]) => !key.startsWith(`${id}\n`)),
    );
  }
}

// the body, read once per open and kept; a read that a write overtook
// (a refresh landed while it was in flight) keeps nothing, since the
// write's word is the fresher one
export async function readSkill(id: string): Promise<string> {
  const held = bodies.value[id];
  if (held !== undefined) return held;
  const forUser = owner;
  const mine = turn;
  const answer = await api<SkillResponse>(
    `/api/skills/${encodeURIComponent(id)}`,
  );
  if (owner === forUser && turn === mine) {
    bodies.value = { ...bodies.value, [id]: answer.body };
  }
  return answer.body;
}

export async function readSkillFile(id: string, path: string): Promise<string> {
  const key = fileKey(id, path);
  const held = files.value[key];
  if (held !== undefined) return held;
  const forUser = owner;
  const mine = turn;
  const answer = await api<SkillFileResponse>(
    `/api/skills/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
  );
  if (owner === forUser && turn === mine) {
    files.value = { ...files.value, [key]: answer.content };
  }
  return answer.content;
}

// a site's index: a plain call, its answer belongs to the form that
// asked
export async function discoverSkills(url: string): Promise<IndexEntry[]> {
  const answer = await api<DiscoverResponse>("/api/skills/discover", "POST", {
    url,
  });
  return answer.entries;
}
