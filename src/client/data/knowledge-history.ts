// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A knowledge file's history as its page reads it: the versions newest
// first, and the versions opened with their text and rendering, held
// per file and per version. A version never changes, so one read of it
// is kept; the list of versions is read again after a write.

import { batch, effect, signal } from "@preact/signals";
import type {
  KnowledgeVersionDetailResponse,
  KnowledgeVersionsResponse,
} from "../../shared/api/knowledge.ts";
import type {
  KnowledgeVersion,
  KnowledgeVersionView,
} from "../../shared/contracts/knowledge.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { capped, lastLiveVersion, revisionPair } from "./knowledge-rows.ts";
import { me } from "./me.ts";
import { onSocketEvent } from "./socket.ts";

export type DocHistory =
  | { state: "loading" }
  | { state: "done"; versions: KnowledgeVersion[] }
  | { state: "failed"; failure: Failure };

export type DocVersion =
  | { state: "loading" }
  | { state: "done"; version: KnowledgeVersionView }
  | { state: "failed"; failure: Failure };

// a deleted file's last text: none when its history kept no text
export type DocLastText =
  | { state: "loading" }
  | { state: "done"; version: KnowledgeVersionView }
  | { state: "none" }
  | { state: "failed"; failure: Failure };

const HELD_FILES = 16;
const HELD_VERSIONS = 64;

export const docHistories = signal<ReadonlyMap<string, DocHistory>>(new Map());
export const docVersions = signal<ReadonlyMap<string, DocVersion>>(new Map());

export const historyOf = (fileId: string): DocHistory =>
  docHistories.value.get(fileId) ?? { state: "loading" };

export const versionOf = (versionId: string): DocVersion =>
  docVersions.value.get(versionId) ?? { state: "loading" };

let owner: string | null = null;
// one count for every load, so a turn dropped with its entry is never
// taken for a later one
let seq = 0;
const historyTurns = new Map<string, number>();
// the project of each history held, for a bin emptied and a revocation
const historyProjects = new Map<string, string>();
const versionTurns = new Map<string, number>();
// the project and, once read, the file of each version held
const versionOwners = new Map<string, { projectId: string; fileId: string }>();

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  historyTurns.clear();
  historyProjects.clear();
  versionTurns.clear();
  versionOwners.clear();
  docHistories.value = new Map();
  docVersions.value = new Map();
});

const base = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/knowledge`;

const filePath = (projectId: string, fileId: string) =>
  `${base(projectId)}/files/${encodeURIComponent(fileId)}`;

export const historyHeld = (fileId: string): boolean =>
  docHistories.value.has(fileId);

// the versions, newest first; a load again keeps the held list on
// screen until its answer lands, and a failed one drops it
export async function loadHistory(
  projectId: string,
  fileId: string,
  again = false,
): Promise<KnowledgeVersion[] | null> {
  const held = docHistories.value.get(fileId);
  if (held?.state === "done" && !again) return held.versions;
  const forUser = owner;
  const turn = ++seq;
  historyTurns.set(fileId, turn);
  historyProjects.set(fileId, projectId);
  if (held === undefined || held.state === "failed") {
    setHistory(fileId, { state: "loading" });
  }
  const current = () => owner === forUser && historyTurns.get(fileId) === turn;
  try {
    const answer = await api<KnowledgeVersionsResponse>(
      `${filePath(projectId, fileId)}/versions`,
    );
    if (current()) {
      setHistory(fileId, { state: "done", versions: answer.versions });
    }
    return answer.versions;
  } catch (err) {
    if (current()) {
      setHistory(fileId, { state: "failed", failure: failure(err) });
    }
    return null;
  }
}

function setHistory(fileId: string, history: DocHistory): void {
  const next = capped(docHistories.value, fileId, history, HELD_FILES);
  for (const id of docHistories.value.keys()) {
    if (!next.has(id)) {
      historyTurns.delete(id);
      historyProjects.delete(id);
    }
  }
  docHistories.value = next;
}

function setVersion(versionId: string, value: DocVersion): void {
  const next = capped(docVersions.value, versionId, value, HELD_VERSIONS);
  for (const id of docVersions.value.keys()) {
    if (!next.has(id)) {
      versionTurns.delete(id);
      versionOwners.delete(id);
    }
  }
  docVersions.value = next;
}

// a version with its text and rendering; a version never changes, so
// one read is kept
export async function loadVersionView(
  projectId: string,
  versionId: string,
): Promise<KnowledgeVersionView | null> {
  const held = docVersions.value.get(versionId);
  if (held?.state === "done") return held.version;
  const forUser = owner;
  const turn = ++seq;
  versionTurns.set(versionId, turn);
  versionOwners.set(versionId, {
    projectId,
    fileId: versionOwners.get(versionId)?.fileId ?? "",
  });
  const current = () =>
    owner === forUser && versionTurns.get(versionId) === turn;
  if (held === undefined || held.state === "failed") {
    setVersion(versionId, { state: "loading" });
  }
  try {
    const answer = await api<KnowledgeVersionDetailResponse>(
      `${base(projectId)}/versions/${encodeURIComponent(versionId)}`,
    );
    if (current()) {
      versionOwners.set(versionId, {
        projectId,
        fileId: answer.version.fileId,
      });
      setVersion(versionId, { state: "done", version: answer.version });
    }
    return answer.version;
  } catch (err) {
    if (current())
      setVersion(versionId, { state: "failed", failure: failure(err) });
    return null;
  }
}

// ?revision=: the versions, that revision and the one it is compared
// with
export async function loadRevision(
  projectId: string,
  fileId: string,
  revision: number,
): Promise<void> {
  const versions = await loadHistory(projectId, fileId);
  if (versions === null) return;
  const pair = revisionPair(versions, revision);
  await Promise.all(
    [pair.version, pair.before].map((version) =>
      version === null ? null : loadVersionView(projectId, version.id),
    ),
  );
}

// the last text of a deleted file: its history, then the newest
// version that holds a text
export async function loadDeletedText(
  projectId: string,
  fileId: string,
): Promise<KnowledgeVersionView | null> {
  const versions = await loadHistory(projectId, fileId);
  if (versions === null) return null;
  const last = lastLiveVersion(versions);
  return last === null ? null : loadVersionView(projectId, last.id);
}

export function lastTextOf(fileId: string): DocLastText {
  const history = historyOf(fileId);
  if (history.state !== "done") return history;
  const last = lastLiveVersion(history.versions);
  if (last === null) return { state: "none" };
  return versionOf(last.id);
}

function dropVersions(
  keep: (owner: { projectId: string; fileId: string }) => boolean,
): void {
  const ids = [...docVersions.value.keys()].filter((id) => {
    const held = versionOwners.get(id);
    return held !== undefined && !keep(held);
  });
  if (ids.length === 0) return;
  const next = new Map(docVersions.value);
  for (const id of ids) {
    next.delete(id);
    versionTurns.delete(id);
    versionOwners.delete(id);
  }
  docVersions.value = next;
}

// a bin emptied: the history of every deleted file of the project is
// gone for good, so it holds no version and its last text is none. A
// file is deleted when its newest version is a delete, or when the page
// says so
export function forgetHistories(
  projectId: string,
  gone: (fileId: string) => boolean,
): void {
  const ids = [...docHistories.value].flatMap(([fileId, history]) =>
    historyProjects.get(fileId) === projectId &&
    (gone(fileId) ||
      (history.state === "done" && history.versions[0]?.deleted === true))
      ? [fileId]
      : [],
  );
  if (ids.length === 0) return;
  batch(() => {
    const next = new Map(docHistories.value);
    for (const fileId of ids) {
      // an answer in flight was read before the bin was emptied
      historyTurns.set(fileId, ++seq);
      next.set(fileId, { state: "done", versions: [] });
    }
    docHistories.value = next;
    const emptied = new Set(ids);
    dropVersions(
      (held) => held.projectId !== projectId || !emptied.has(held.fileId),
    );
  });
}

// a project no longer seen: nothing of its history stays
function forgetProject(projectId: string): void {
  batch(() => {
    const ids = [...historyProjects].flatMap(([fileId, project]) =>
      project === projectId ? [fileId] : [],
    );
    if (ids.length > 0) {
      const next = new Map(docHistories.value);
      for (const fileId of ids) {
        next.delete(fileId);
        historyTurns.delete(fileId);
        historyProjects.delete(fileId);
      }
      docHistories.value = next;
    }
    dropVersions((held) => held.projectId !== projectId);
  });
}

export function onHistorySocket(ev: SocketEvent): void {
  if (ev.type === "revoked") forgetProject(ev.projectId);
}

onSocketEvent(onHistorySocket);
