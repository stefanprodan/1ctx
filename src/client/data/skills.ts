// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { effect, signal } from "@preact/signals";
import type {
  AddSkillRequest,
  DiscoverResponse,
  SkillFileResponse,
  SkillResponse,
  SkillsResponse,
  SkillsUsageResponse,
  SkillUsageResponse,
} from "../../shared/api/skills.ts";
import type { IndexEntry, SkillSummary } from "../../shared/contracts/skill.ts";
import { type Failure, failure } from "../lib/format.ts";
import { byName } from "../lib/search.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";
import { instanceSlot, usageSlot } from "./slot.ts";

export const skills = signal<SkillSummary[] | null>(null);
export const skillsError = signal<Failure | null>(null);
export const bodies = signal<Record<string, string>>({});
export const files = signal<Record<string, string>>({});

export const skillUsage = usageSlot<SkillUsageResponse>(
  (id) => `/api/skills/${encodeURIComponent(id)}/usage`,
);
export const loadSkillUsage = skillUsage.load;
export const allSkillUsage =
  instanceSlot<SkillsUsageResponse>("/api/usage/skills");
export const loadAllSkillUsage = allSkillUsage.load;

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

let turn = 0;
// a body or file read a write overtook reads again: the write dropped
// the files and nothing else would ask for them
let writes = 0;

export async function loadSkills(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  skillsError.value = null;
  try {
    const body = await api<SkillsResponse>("/api/skills");
    if (owner === forUser && turn === mine) skills.value = byName(body.skills);
  } catch (err) {
    if (owner === forUser && turn === mine) skillsError.value = failure(err);
  }
}

const withoutFiles = (id: string) =>
  Object.fromEntries(
    Object.entries(files.value).filter(([key]) => !key.startsWith(`${id}\n`)),
  );

function keep({ skill, body }: SkillResponse): void {
  skills.value = byName([
    ...(skills.value ?? []).filter((s) => s.id !== skill.id),
    skill,
  ]);
  bodies.value = { ...bodies.value, [skill.id]: body };
  files.value = withoutFiles(skill.id);
}

export async function addSkill(body: AddSkillRequest): Promise<SkillSummary> {
  const forUser = owner;
  const answer = await api<SkillResponse>("/api/skills", "POST", body);
  turn++;
  writes++;
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
  writes++;
  if (owner === forUser) keep(answer);
  return answer.skill;
}

export async function deleteSkill(id: string): Promise<void> {
  const forUser = owner;
  await api(`/api/skills/${encodeURIComponent(id)}`, "DELETE");
  turn++;
  writes++;
  if (owner === forUser) {
    skills.value = (skills.value ?? []).filter((s) => s.id !== id);
    const nextBodies = { ...bodies.value };
    delete nextBodies[id];
    bodies.value = nextBodies;
    files.value = withoutFiles(id);
  }
}

export async function readSkill(id: string): Promise<string> {
  const held = bodies.value[id];
  if (held !== undefined) return held;
  const forUser = owner;
  const mine = writes;
  const answer = await api<SkillResponse>(
    `/api/skills/${encodeURIComponent(id)}`,
  );
  if (owner !== forUser) return answer.body;
  if (writes !== mine) return readSkill(id);
  bodies.value = { ...bodies.value, [id]: answer.body };
  return answer.body;
}

export async function readSkillFile(id: string, path: string): Promise<string> {
  const key = fileKey(id, path);
  const held = files.value[key];
  if (held !== undefined) return held;
  const forUser = owner;
  const mine = writes;
  const answer = await api<SkillFileResponse>(
    `/api/skills/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
  );
  if (owner !== forUser) return answer.content;
  if (writes !== mine) return readSkillFile(id, path);
  files.value = { ...files.value, [key]: answer.content };
  return answer.content;
}

export async function discoverSkills(url: string): Promise<IndexEntry[]> {
  const answer = await api<DiscoverResponse>("/api/skills/discover", "POST", {
    url,
  });
  return answer.entries;
}
