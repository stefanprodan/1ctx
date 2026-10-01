// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { effect, signal } from "@preact/signals";
import type {
  CreateRepoRequest,
  PatchRepoRequest,
  RepoResponse,
  ReposResponse,
  RepoView,
} from "../../shared/api/repos.ts";
import { type Failure, failure } from "../lib/format.ts";
import { browserTab, type PollDriver, pollWhileSeen } from "../lib/poll.ts";
import { ApiError, api } from "./api.ts";
import { me } from "./me.ts";

// a project's repositories, in name order, by project id
export const repoLists = signal<ReadonlyMap<string, RepoView[]>>(new Map());
export const repoErrors = signal<ReadonlyMap<string, Failure>>(new Map());

// how often a list with a row waiting or fetching is read again
export const REPO_POLL_MS = 3000;

// who writes: an admin a team project's, an owner their personal one's
export type RepoTarget = { projectId: string; personal: boolean };

let owner: string | null = null;
const turns = new Map<string, number>();

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  turns.clear();
  repoLists.value = new Map();
  repoErrors.value = new Map();
});

export const reposOf = (projectId: string): RepoView[] | null =>
  repoLists.value.get(projectId) ?? null;

export const repoErrorOf = (projectId: string): Failure | null =>
  repoErrors.value.get(projectId) ?? null;

// a row the server has yet to settle
export const unsettled = (list: readonly RepoView[] | null): boolean =>
  list?.some((r) => r.state === "pending" || r.state === "fetching") ?? false;

const listUrl = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/repos`;

const writeUrl = (target: RepoTarget, id?: string) => {
  const base = target.personal
    ? "/api/profile/project/repos"
    : listUrl(target.projectId);
  return id === undefined ? base : `${base}/${encodeURIComponent(id)}`;
};

const turnOf = (projectId: string) => {
  const next = (turns.get(projectId) ?? 0) + 1;
  turns.set(projectId, next);
  return next;
};

function setList(projectId: string, list: RepoView[]): void {
  const next = new Map(repoLists.value);
  next.set(projectId, list);
  repoLists.value = next;
}

function setError(projectId: string, error: Failure | null): void {
  if (error === null && !repoErrors.value.has(projectId)) return;
  const next = new Map(repoErrors.value);
  if (error === null) next.delete(projectId);
  else next.set(projectId, error);
  repoErrors.value = next;
}

export async function loadRepos(projectId: string): Promise<void> {
  const forUser = owner;
  const mine = turnOf(projectId);
  try {
    const body = await api<ReposResponse>(listUrl(projectId));
    if (owner !== forUser || turns.get(projectId) !== mine) return;
    setList(projectId, body.repos);
    setError(projectId, null);
  } catch (err) {
    if (owner !== forUser || turns.get(projectId) !== mine) return;
    setError(projectId, failure(err));
  }
}

const byName = (a: RepoView, b: RepoView) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

// a write's answer lands over any load out, which may predate it
function keep(projectId: string, repo: RepoView, forUser: string | null) {
  if (owner !== forUser) return;
  turnOf(projectId);
  const list = reposOf(projectId) ?? [];
  setList(
    projectId,
    [...list.filter((r) => r.id !== repo.id), repo].sort(byName),
  );
}

function drop(projectId: string, id: string, forUser: string | null) {
  if (owner !== forUser) return;
  turnOf(projectId);
  const list = reposOf(projectId);
  if (list !== null) {
    setList(
      projectId,
      list.filter((r) => r.id !== id),
    );
  }
}

// a 404 on a row: another tab deleted it, so the list reads again
async function onRow<T>(
  target: RepoTarget,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      void loadRepos(target.projectId);
    }
    throw err;
  }
}

export async function addRepo(
  target: RepoTarget,
  body: CreateRepoRequest,
): Promise<RepoView> {
  const forUser = owner;
  const { repo } = await api<RepoResponse>(writeUrl(target), "POST", body);
  keep(target.projectId, repo, forUser);
  return repo;
}

export async function changeRepo(
  target: RepoTarget,
  id: string,
  body: PatchRepoRequest,
): Promise<RepoView> {
  const forUser = owner;
  const { repo } = await onRow(target, () =>
    api<RepoResponse>(writeUrl(target, id), "PATCH", body),
  );
  keep(target.projectId, repo, forUser);
  return repo;
}

export async function refreshRepo(
  target: RepoTarget,
  id: string,
): Promise<RepoView> {
  const forUser = owner;
  const { repo } = await onRow(target, () =>
    api<RepoResponse>(`${writeUrl(target, id)}/refresh`, "POST"),
  );
  keep(target.projectId, repo, forUser);
  return repo;
}

// a repository another tab deleted is gone all the same
export async function deleteRepo(target: RepoTarget, id: string) {
  const forUser = owner;
  try {
    await api<unknown>(writeUrl(target, id), "DELETE");
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  drop(target.projectId, id, forUser);
}

// while mounted: the list reads again every REPO_POLL_MS, only while a
// row waits or fetches and the tab is seen, since no frame says a fetch
// ended
export function watchRepos(
  projectId: string,
  tab: PollDriver = browserTab,
): () => void {
  let stopPoll: (() => void) | null = null;
  const stopEffect = effect(() => {
    const busy = unsettled(reposOf(projectId));
    if (busy && stopPoll === null) {
      stopPoll = pollWhileSeen(
        REPO_POLL_MS,
        () => void loadRepos(projectId),
        tab,
      );
    } else if (!busy && stopPoll !== null) {
      stopPoll();
      stopPoll = null;
    }
  });
  return () => {
    stopEffect();
    stopPoll?.();
    stopPoll = null;
  };
}
