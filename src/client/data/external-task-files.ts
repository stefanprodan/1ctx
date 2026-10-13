// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A task's linked file opened in place on its page: read on the click,
// rendered by the server, and kept by its revision, so a file written
// since is read again. The least recent past HELD_FILES go, as the
// knowledge pages' do. A knowledge frame for a file drops what is held
// of it, and a revoked project all of its files, a read still out for
// either landing nowhere; everything goes with the signed-in user.

import { effect, signal } from "@preact/signals";
import type { KnowledgeFileDetailResponse } from "../../shared/api/knowledge.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { capped } from "./knowledge-rows.ts";
import { me } from "./me.ts";
import { onSocketEvent } from "./socket.ts";

export type TaskFileRead =
  | { state: "loading" }
  | { state: "failed"; failure: Failure }
  | { state: "done"; html: string | null; text: string };

type Held = { projectId: string; fileId: string; read: TaskFileRead };

export const HELD_FILES = 16;

// by file id and the revision the task's link names
export const taskFiles = signal<ReadonlyMap<string, Held>>(new Map());

let owner: string | null = null;
// bumped by a frame for a file or a revoke of its project, so a read
// started before either keeps nothing
const fileTurns = new Map<string, number>();
const projectTurns = new Map<string, number>();

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  fileTurns.clear();
  projectTurns.clear();
  taskFiles.value = new Map();
});

export const taskFileKey = (fileId: string, revision: number | null) =>
  `${fileId}@${revision ?? "-"}`;

export const taskFileRead = (
  fileId: string,
  revision: number | null,
): TaskFileRead | undefined =>
  taskFiles.value.get(taskFileKey(fileId, revision))?.read;

// a row opened reads a file not held or one whose read failed
export const readsOnOpen = (read: TaskFileRead | undefined): boolean =>
  read === undefined || read.state === "failed";

const bump = (turns: Map<string, number>, key: string) =>
  turns.set(key, (turns.get(key) ?? 0) + 1);

// one read per file and revision; a failed one is asked again
export async function openTaskFile(
  projectId: string,
  fileId: string,
  revision: number | null,
): Promise<void> {
  const key = taskFileKey(fileId, revision);
  const held = taskFiles.value.get(key);
  if (held !== undefined && held.read.state !== "failed") return;
  const forUser = owner;
  const fileTurn = fileTurns.get(fileId) ?? 0;
  const projectTurn = projectTurns.get(projectId) ?? 0;
  const put = (read: TaskFileRead) => {
    if (
      owner !== forUser ||
      (fileTurns.get(fileId) ?? 0) !== fileTurn ||
      (projectTurns.get(projectId) ?? 0) !== projectTurn
    ) {
      return;
    }
    taskFiles.value = capped(
      taskFiles.value,
      key,
      { projectId, fileId, read },
      HELD_FILES,
    );
  };
  put({ state: "loading" });
  try {
    const { file } = await api<KnowledgeFileDetailResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/knowledge/files/${encodeURIComponent(fileId)}`,
    );
    put({ state: "done", html: file.html, text: file.text });
  } catch (err) {
    put({ state: "failed", failure: failure(err) });
  }
}

function drop(keep: (held: Held) => boolean): void {
  const next = new Map([...taskFiles.value].filter(([, held]) => keep(held)));
  if (next.size !== taskFiles.value.size) taskFiles.value = next;
}

export function onTaskFilesSocket(ev: SocketEvent): void {
  if (ev.type === "knowledge") {
    bump(fileTurns, ev.file.id);
    drop((held) => held.fileId !== ev.file.id);
  } else if (ev.type === "revoked") {
    bump(projectTurns, ev.projectId);
    drop((held) => held.projectId !== ev.projectId);
  }
}

onSocketEvent(onTaskFilesSocket);
