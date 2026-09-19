// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The files a person staged for a chat, by project: what the server
// holds for the signed-in user and the limits in force, which the
// composer judges a pick with. A route's load fills it, a socket open
// fills it again, and a write (an upload's answer, a delete) supersedes
// a load in flight, so a list never brings back what was just removed.

import { effect, signal } from "@preact/signals";
import type {
  StagedUploadResponse,
  StagedUploadsResponse,
} from "../../shared/api/knowledge.ts";
import type {
  StagedUpload,
  StagedUploads,
} from "../../shared/contracts/knowledge.ts";
import { api, upload } from "./api.ts";
import { me } from "./me.ts";

// a staged item that is held: its id is never null
export type Staged = StagedUpload & { id: string };

export const staged = signal<ReadonlyMap<string, StagedUploads>>(new Map());

let owner: string | null = null;
const turns = new Map<string, number>();
// uploads let go before their answer came, by attempt: the server may
// hold one anyway, and a list that shows it has it deleted
const forgotten = new Set<string>();
// a clock of stamps: a file the composer is unsure of is only called
// gone by a list whose request started after it went unknown, since an
// older request may answer late
let clock = 0;
const asked = new Map<string, number>();
const inflight = new Map<string, Promise<boolean>>();

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  turns.clear();
  forgotten.clear();
  asked.clear();
  inflight.clear();
  staged.value = new Map();
});

const base = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/uploads`;

const bump = (projectId: string) => {
  const turn = (turns.get(projectId) ?? 0) + 1;
  turns.set(projectId, turn);
  return turn;
};

function keep(projectId: string, list: StagedUploads): void {
  const next = new Map(staged.value);
  next.set(projectId, list);
  staged.value = next;
}

export function takeStamp(): number {
  clock += 1;
  return clock;
}

// the stamp the held list's request started under, 0 without a list
export function askedOf(projectId: string): number {
  return asked.get(projectId) ?? 0;
}

export function stagedOf(projectId: string): StagedUploads | null {
  return staged.value.get(projectId) ?? null;
}

// a failed load keeps what is held: the composer still has its limits.
// Loads of one project share a request, and only a write that lands
// while it is in flight makes it ask again, a few times at most: two
// loads never chase each other
const MAX_LOAD_TRIES = 3;

export function loadUploads(projectId: string): Promise<boolean> {
  const running = inflight.get(projectId);
  if (running !== undefined) return running;
  const run = load(projectId).finally(() => {
    if (inflight.get(projectId) === run) inflight.delete(projectId);
  });
  inflight.set(projectId, run);
  return run;
}

async function load(projectId: string): Promise<boolean> {
  const forUser = owner;
  try {
    for (let tries = 0; tries < MAX_LOAD_TRIES; tries++) {
      const turn = turns.get(projectId) ?? 0;
      const started = takeStamp();
      const list = await api<StagedUploadsResponse>(base(projectId));
      if (owner !== forUser) return false;
      // a write overtook it: its rows are older than what is held
      if ((turns.get(projectId) ?? 0) !== turn) continue;
      const orphans = list.items.filter((item) => forgotten.has(item.attempt));
      asked.set(projectId, started);
      keep(projectId, {
        ...list,
        items: list.items.filter((item) => !orphans.includes(item)),
      });
      for (const item of orphans) {
        forgotten.delete(item.attempt);
        if (item.id !== null) void deleteUpload(projectId, item.id);
      }
      return true;
    }
  } catch {
    // the next load, or the send's own refusal, says what is wrong
  }
  return false;
}

export async function stageUpload(
  projectId: string,
  file: File,
  attempt: string,
  options: {
    onProgress?: (sent: number, total: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<StagedUpload> {
  const forUser = owner;
  const query = new URLSearchParams({ name: file.name, attempt });
  const answer = await upload<StagedUploadResponse>(
    `${base(projectId)}?${query}`,
    file,
    options,
  );
  bump(projectId);
  const held = stagedOf(projectId);
  if (owner === forUser && held !== null && answer.id !== null) {
    keep(projectId, {
      ...held,
      items: [...held.items.filter((item) => item.id !== answer.id), answer],
    });
  }
  return answer;
}

export async function deleteUpload(
  projectId: string,
  id: string,
): Promise<void> {
  const forUser = owner;
  bump(projectId);
  const held = stagedOf(projectId);
  if (held !== null) {
    keep(projectId, {
      ...held,
      items: held.items.filter((item) => item.id !== id),
    });
  }
  try {
    await api(`${base(projectId)}/${encodeURIComponent(id)}`, "DELETE");
  } catch {
    // gone already, or it goes with its lease
  }
  if (owner === forUser) bump(projectId);
}

export function forgetUpload(attempt: string): void {
  forgotten.add(attempt);
}

// a send claimed these: they are no longer staged
export function claimed(projectId: string, ids: readonly string[]): void {
  const held = stagedOf(projectId);
  if (held === null || ids.length === 0) return;
  bump(projectId);
  keep(projectId, {
    ...held,
    items: held.items.filter((item) => !ids.includes(item.id ?? "")),
  });
}
